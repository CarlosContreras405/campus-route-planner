from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request
from openai import OpenAI

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

app = Flask(__name__)
app.config["GOOGLE_MAPS_API_KEY"] = os.environ.get("GOOGLE_MAPS_API_KEY", "")

with open(DATA_DIR / "buildings.json", "r", encoding="utf-8") as f:
    BUILDINGS = {item["code"].upper(): item for item in json.load(f)}

with open(DATA_DIR / "courses.json", "r", encoding="utf-8") as f:
    COURSES = {item["course_code"].upper(): item for item in json.load(f)}

client_openai = OpenAI(api_key=os.environ.get("OPENAI_API_KEY", ""))


@app.route("/")
def index() -> str:
    return render_template(
        "index.html",
        google_maps_api_key=app.config["GOOGLE_MAPS_API_KEY"]
    )


@app.route("/api/parse-schedule-image", methods=["POST"])
def parse_schedule_image():
    data = request.get_json(silent=True) or {}
    image_b64 = data.get("image")
    media_type = data.get("media_type", "image/jpeg")

    if not image_b64:
        return jsonify({"error": "No image was provided."}), 400

    response = client_openai.chat.completions.create(
        model="gpt-4o",
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{media_type};base64,{image_b64}"
                    }
                },
                {
                    "type": "text",
                    "text": """Extract the class schedule from this image.
Return ONLY a JSON array, no explanation.
Each class meeting should be its own entry and include:
- "course": course code (e.g., COP3514)
- "building": abbreviated building code when in person (e.g., ISA), otherwise empty string
- "start": class start time in 12-hour format like 09:30 AM
- "days": array of meeting day abbreviations for that meeting, with variable size (e.g., ["M","W","F"] or ["T"])
- "instruction_mode": "IN_PERSON", "ONLINE", "OFFLINE", or "UNKNOWN"
Example:
[{"course":"COP3514","building":"ISA","start":"09:30 AM","days":["M","W"],"instruction_mode":"IN_PERSON"}]
If any field is unclear, use an empty string (or [] for days)."""
                }
            ]
        }],
        max_tokens=500
    )

    raw = response.choices[0].message.content
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    schedule = json.loads(match.group()) if match else []
    return jsonify({"schedule": schedule})


@app.route("/api/route", methods=["POST"])
def get_route():
    data = request.get_json(silent=True) or {}
    buildings = data.get("buildings", [])
    
    buildings = [b for b in buildings if b.get("lat") is not None and b.get("lng") is not None]

    if len(buildings) < 2:
        return jsonify({"error": "Need at least 2 buildings"}), 400

    if not app.config["GOOGLE_MAPS_API_KEY"]:
        return jsonify({"error": "GOOGLE_MAPS_API_KEY is missing."}), 500

    waypoints = [
        {
            "location": {
                "latLng": {
                    "latitude": float(b["lat"]),
                    "longitude": float(b["lng"]),
                }
            }
        }
        for b in buildings
    ]

    def call_routes_api(travel_mode: str):
        payload = {
            "origin": waypoints[0],
            "destination": waypoints[-1],
            "intermediates": waypoints[1:-1],
            "travelMode": travel_mode,
            "polylineEncoding": "ENCODED_POLYLINE",
        }

        resp = requests.post(
            "https://routes.googleapis.com/directions/v2:computeRoutes",
            headers={
                "Content-Type": "application/json",
                "X-Goog-Api-Key": app.config["GOOGLE_MAPS_API_KEY"],
                "X-Goog-FieldMask": (
                    "routes.polyline.encodedPolyline,"
                    "routes.duration,"
                    "routes.distanceMeters,"
                    "routes.legs.duration,"
                    "routes.legs.distanceMeters,"
                    "routes.legs.polyline.encodedPolyline"
                ),
            },
            json=payload,
            timeout=20,
        )

        try:
            response_json = resp.json()
        except ValueError:
            response_json = {"raw_text": resp.text}

        print(f"\n=== ROUTES API RESPONSE ({travel_mode}) ===")
        print("status:", resp.status_code)
        print(json.dumps(response_json, indent=2))

        return resp, response_json

    resp, response_json = call_routes_api("WALK")

    if resp.ok and response_json.get("routes"):
        route = response_json["routes"][0]
        polyline = route.get("polyline", {}).get("encodedPolyline")

        if polyline:
            return jsonify({
                "polyline": polyline,
                "duration": route.get("duration", "0s"),
                "distance_meters": route.get("distanceMeters", 0),
                "travel_mode": "WALK",
                "legs": [
                    {
                        "duration": leg.get("duration", "0s"),
                        "distance_meters": leg.get("distanceMeters", 0),
                        "polyline": leg.get("polyline", {}).get("encodedPolyline"),
                    }
                    for leg in route.get("legs", [])
                ],
            })

    resp2, response_json2 = call_routes_api("DRIVE")

    if resp2.ok and response_json2.get("routes"):
        route = response_json2["routes"][0]
        polyline = route.get("polyline", {}).get("encodedPolyline")

        if polyline:
            return jsonify({
                "polyline": polyline,
                "duration": route.get("duration", "0s"),
                "distance_meters": route.get("distanceMeters", 0),
                "travel_mode": "DRIVE",
                "legs": [
                    {
                        "duration": leg.get("duration", "0s"),
                        "distance_meters": leg.get("distanceMeters", 0),
                        "polyline": leg.get("polyline", {}).get("encodedPolyline"),
                    }
                    for leg in route.get("legs", [])
                ],
                "warning": "Walking route was unavailable, so a driving fallback was used."
            })

    return jsonify({
        "error": "Google returned no route for WALK or DRIVE. Check your building coordinates.",
        "walk_response": response_json,
        "drive_response": response_json2,
    }), 404


@app.route("/api/buildings", methods=["POST"])
def lookup_buildings():
    payload: dict[str, Any] = request.get_json(silent=True) or {}
    codes = payload.get("buildings", [])

    if not isinstance(codes, list):
        return jsonify({"error": "'buildings' must be a list"}), 400

    found = []
    missing = []

    for code in codes:
        normalized = str(code).strip().upper()
        if not normalized:
            continue
        item = BUILDINGS.get(normalized)
        if item:
            found.append(item)
        else:
            missing.append(normalized)

    return jsonify({"found": found, "missing": missing})


@app.route("/api/course-summary", methods=["POST"])
def course_summary():
    payload: dict[str, Any] = request.get_json(silent=True) or {}
    course_codes = payload.get("courses", [])
    schedule = payload.get("schedule", [])

    if not isinstance(course_codes, list):
        return jsonify({"error": "'courses' must be a list"}), 400

    selected_courses = []
    missing = []

    for code in course_codes:
        normalized = str(code).strip().upper()
        if not normalized:
            continue
        item = COURSES.get(normalized)
        if item:
            selected_courses.append(item)
        else:
            missing.append(normalized)

    summary = build_daily_summary(selected_courses, schedule)
    return jsonify({
        "courses": selected_courses,
        "missing": missing,
        "summary": summary,
    })


def build_daily_summary(selected_courses: list[dict[str, Any]], schedule: list[dict[str, Any]]) -> str:
    if not selected_courses and not schedule:
        return (
            "No courses were matched yet. Try entering a few course codes like COP3514, MAC2311, "
            "or PHY2048 so the app can generate a plain-English academic summary."
        )

    pieces: list[str] = []

    if schedule:
        ordered = [s for s in schedule if isinstance(s, dict)]
        if ordered:
            first = ordered[0]
            last = ordered[-1]
            first_b = str(first.get("building", "")).upper()
            last_b = str(last.get("building", "")).upper()
            first_t = str(first.get("start", "")).strip()
            last_t = str(last.get("start", "")).strip()

            if first_b and first_t:
                pieces.append(f"Your day starts at {first_t} in {first_b}.")
            if last_b and last_t and (last_b != first_b or last_t != first_t):
                pieces.append(f"Your last listed class begins at {last_t} in {last_b}.")

    if selected_courses:
        focus_areas = [c.get("focus", "coursework") for c in selected_courses]
        course_names = [f"{c['course_code']} ({c['course_name']})" for c in selected_courses]

        if len(course_names) == 1:
            pieces.append(f"Today includes {course_names[0]}.")
        else:
            pieces.append("Today includes " + ", ".join(course_names[:-1]) + f", and {course_names[-1]}.")

        if len(focus_areas) == 1:
            pieces.append(f"Overall, your classes focus on {focus_areas[0]}.")
        else:
            pieces.append("Overall, your classes focus on " + ", ".join(focus_areas[:-1]) + f", and {focus_areas[-1]}.")

        first_course = selected_courses[0]
        pieces.append(
            f"{first_course['course_code']} is about {first_course['student_friendly_summary'].rstrip('.')}."
        )

    pieces.append(
        "Use the route view below to check whether your walking time between buildings looks comfortable, and leave a few minutes early if two buildings are far apart."
    )

    return " ".join(piece for piece in pieces if piece)


if __name__ == "__main__":
    print("GOOGLE MAPS KEY LOADED:", "YES" if app.config["GOOGLE_MAPS_API_KEY"] else "NO")
    app.run(debug=True)

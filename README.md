# USF Campus Navigator Demo

A hackathon-friendly demo app that:
- accepts a student's schedule input
- looks up USF-style building codes from a local JSON dataset
- generates a plain-English daily course summary
- optionally renders Google Maps walking directions if you add your API key

## Stack
- Frontend: HTML, CSS, JavaScript
- Backend: Flask (Python)
- Data: local JSON files

## Quick start

```bash
python -m venv .venv
source .venv/bin/activate   # macOS/Linux
# .venv\Scripts\activate    # Windows PowerShell
pip install -r requirements.txt
python app.py
```

Then open the local URL Flask prints in the terminal.

## Enable Google Maps
Create a `.env` file in `usf-campus-navigator-demo/` with:

```bash
GOOGLE_MAPS_API_KEY=PASTE_YOUR_GOOGLE_MAPS_API_KEY_HERE
```

Then restart Flask. The app injects this value into the Google Maps script tag.

If the map still does not load, verify your key has these APIs enabled in Google Cloud:
- Maps JavaScript API
- Directions API

### Troubleshooting `No walking route found (REQUEST_DENIED)`
If route cards show `REQUEST_DENIED`, Google accepted the map load but denied Directions calls. This is usually one of these:
- Billing is not enabled on the Google Cloud project.
- **Directions API** is not enabled (Maps JavaScript API alone is not enough).
- The API key has API restrictions that do not include Directions API.
- The API key has HTTP referrer restrictions that do not include your local origin (for example `http://localhost:*` and `http://127.0.0.1:*`).

Tip: Open browser dev tools and inspect the failing Directions request. Google often returns a more specific `error_message` alongside `REQUEST_DENIED`.

## Demo endpoints
- `POST /api/buildings`
- `POST /api/course-summary`

## Example payloads

### `/api/buildings`
```json
{
  "buildings": ["ISA", "ENG", "CHE"]
}
```

### `/api/course-summary`
```json
{
  "courses": ["COP3514", "MAC2311"],
  "schedule": [
    {"course": "COP3514", "building": "ISA", "start": "09:30 AM"},
    {"course": "MAC2311", "building": "ENG", "start": "11:00 AM"}
  ]
}
```

## Next upgrades
- import a pasted weekly class schedule
- add more USF building codes and course records
- call an LLM API for richer summaries
- add parking, food, and bus-stop layers

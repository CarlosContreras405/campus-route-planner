const runButton = document.getElementById("run-demo");
const loadExampleButton = document.getElementById("load-example");
const addCourseButton = document.getElementById("add-course");
const statusEl = document.getElementById("status");
const summaryEl = document.getElementById("summary");
const buildingResultsEl = document.getElementById("building-results");
const routeFallbackEl = document.getElementById("route-fallback");
const routeResultsEl = document.getElementById("route-results");
const scheduleFormEl = document.getElementById("schedule-form");
const daySliderEl = document.getElementById("day-slider");
const dayLabelEl = document.getElementById("day-slider-label");
const dayPrevEl = document.getElementById("day-prev");
const dayNextEl = document.getElementById("day-next");

const MAX_COURSE_ROWS = 8;
const NEW_ROW_PLACEHOLDERS = {
  course: "COP3514",
  building: "ISA",
  start: "09:30 AM",
};
const EXAMPLE_SCHEDULE = [
  { course: "COP3514", building: "ISA", start: "09:30 AM" },
  { course: "MAC2311", building: "ENG", start: "11:00 AM" },
  { course: "PHY2048", building: "CHE", start: "12:30 PM" },
  { course: "ENC1101", building: "CPR", start: "02:00 PM" },
];

let map = null;
let markers = [];
let mapReady = false;
let pendingMapAction = null;
let currentPolylines = [];
let currentRouteData = null;
let latestBuildRunId = 0;
const routeColorCache = new Map();
const routeCacheByDay = new Map();
const DAY_SEQUENCE = ["M", "T", "W", "R", "F", "S", "U"];
const DAY_LABELS = {
  M: "Mon",
  T: "Tue",
  W: "Wed",
  R: "Thu",
  F: "Fri",
  S: "Sat",
  U: "Sun",
};

const uploadedScheduleState = {
  isActive: false,
  allEntries: [],
  inPersonDays: [],
  selectedDay: "",
};
const ROUTE_COLOR_PALETTE = [
  "#0072B2", // blue
  "#E69F00", // orange
  "#009E73", // bluish green
  "#D55E00", // vermillion
  "#CC79A7", // reddish purple
  "#56B4E9", // sky blue
  "#F0E442", // yellow
  "#332288", // indigo
];
const ROUTE_FALLBACK_COLORS = ["#117733", "#882255", "#44AA99", "#AA4499", "#661100"];

function normalizeDay(day) {
  if (!day) return "";
  const clean = String(day).trim().toUpperCase();
  if (["TH", "THU", "THURSDAY"].includes(clean)) return "R";
  if (["TU", "TUE", "TUESDAY"].includes(clean)) return "T";
  if (["SU", "SUN", "SUNDAY"].includes(clean)) return "U";
  if (["SA", "SAT", "SATURDAY"].includes(clean)) return "S";
  if (["MO", "MON", "MONDAY"].includes(clean)) return "M";
  if (["WE", "WED", "WEDNESDAY"].includes(clean)) return "W";
  if (["FR", "FRI", "FRIDAY"].includes(clean)) return "F";
  return DAY_SEQUENCE.includes(clean.charAt(0)) ? clean.charAt(0) : "";
}

function normalizeDays(days) {
  if (!Array.isArray(days)) return [];
  const normalized = days.map(normalizeDay).filter(Boolean);
  return DAY_SEQUENCE.filter((day) => normalized.includes(day));
}

function normalizeScheduleEntry(rawEntry) {
  const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
  return {
    course: String(entry.course || "").trim().toUpperCase(),
    building: String(entry.building || "").trim().toUpperCase(),
    start: String(entry.start || "").trim(),
    days: normalizeDays(entry.days),
    instruction_mode: String(entry.instruction_mode || "").trim().toUpperCase(),
  };
}

function isInPersonClass(entry) {
  if (!entry) return false;
  const mode = String(entry.instruction_mode || "").toUpperCase();
  const building = String(entry.building || "").toUpperCase();
  const isOnlineLikeMode = ["ONLINE", "OFFLINE", "REMOTE", "VIRTUAL"].includes(mode);
  const isOnlineLikeBuilding = ["ONLINE", "OFF", "OFFT", "OFF-CAMPUS", "TBA"].includes(building);
  return Boolean(building) && !isOnlineLikeMode && !isOnlineLikeBuilding;
}

function formatScheduleDay(dayCode) {
  return DAY_LABELS[dayCode] || dayCode;
}

function offsetDuplicateMarkers(buildings) {
  const seen = {};
  const offset = 0.0001;

  return buildings.map((b) => {
    const key = `${b.lat},${b.lng}`;
    if (seen[key] === undefined) {
      seen[key] = 0;
      return b;
    }

    seen[key] += 1;
    const angle = (seen[key] * 90 * Math.PI) / 180;
    return {
      ...b,
      lat: b.lat + offset * Math.cos(angle),
      lng: b.lng + offset * Math.sin(angle),
    };
  });
}

function sortBuildingsByTime(buildings, schedule) {
  // Map each building code to the earliest actual start time in minutes
  const timeMap = {};
  schedule.forEach((entry) => {
    const code = entry.building.toUpperCase();
    const minutes = parseTimeToMinutes(entry.start);
    if (minutes == null) return;
    if (!(code in timeMap) || minutes < timeMap[code]) {
      timeMap[code] = minutes;
    }
  });

  return [...buildings].sort((a, b) => {
    const aTime = timeMap[a.code.toUpperCase()] ?? 9999;
    const bTime = timeMap[b.code.toUpperCase()] ?? 9999;
    return aTime - bTime;
  });
}

function initMap() {
  const usf = { lat: 28.0587, lng: -82.4139 };

  map = new google.maps.Map(document.getElementById("map"), {
    center: usf,
    zoom: 16,
    mapTypeControl: false,
    streetViewControl: false,
    fullscreenControl: true,
  });

  mapReady = true;

  if (pendingMapAction) {
    pendingMapAction();
    pendingMapAction = null;
  }
}

window.initMap = initMap;

function getRows() {
  return Array.from(document.querySelectorAll("#schedule-form .row")).filter(
    (row) => !row.classList.contains("header-row")
  );
}

function createCourseRow() {
  const row = document.createElement("div");
  row.className = "row";
  row.innerHTML = `
    <input class="course" placeholder="${NEW_ROW_PLACEHOLDERS.course}" />
    <input class="building" placeholder="${NEW_ROW_PLACEHOLDERS.building}" />
    <input class="time" placeholder="${NEW_ROW_PLACEHOLDERS.start}" />
  `;
  return row;
}

function trimRowsToMax(maxRows) {
  const rows = getRows();
  rows.slice(maxRows).forEach((row) => row.remove());
}

function addCourseRow() {
  const currentRows = getRows().length;
  if (currentRows >= MAX_COURSE_ROWS) {
    setStatus(`You can add up to ${MAX_COURSE_ROWS} courses.`, true);
    return;
  }

  scheduleFormEl.appendChild(createCourseRow());
  setStatus(`Added course row ${currentRows + 1} of ${MAX_COURSE_ROWS}.`);
}

function collectSchedule() {
  return getRows()
    .map((row) => ({
      course: row.querySelector(".course").value.trim().toUpperCase(),
      building: row.querySelector(".building").value.trim().toUpperCase(),
      start: row.querySelector(".time").value.trim(),
    }))
    .filter((item) => item.course || item.building || item.start);
}

function sortScheduleChronologically(schedule) {
  return [...schedule].sort((a, b) => {
    const aMinutes = parseTimeToMinutes(a.start);
    const bMinutes = parseTimeToMinutes(b.start);

    if (aMinutes == null && bMinutes == null) return 0;
    if (aMinutes == null) return 1;
    if (bMinutes == null) return -1;
    return aMinutes - bMinutes;
  });
}

function updateRowsWithSchedule(schedule) {
  const rows = getRows();

  rows.forEach((row, index) => {
    const entry = schedule[index] || {};
    row.querySelector(".course").value = entry.course || "";
    row.querySelector(".building").value = entry.building || "";
    row.querySelector(".time").value = entry.start || "";
  });
}

function saveUploadedState() {
  // Upload state is intentionally session-only (no refresh persistence).
}

function clearUploadedState() {
  uploadedScheduleState.isActive = false;
  uploadedScheduleState.allEntries = [];
  uploadedScheduleState.inPersonDays = [];
  uploadedScheduleState.selectedDay = "";
  routeCacheByDay.clear();
  daySliderEl.classList.remove("visible");
  dayLabelEl.textContent = "Day";
  saveUploadedState();
}

function renderDaySlider() {
  if (!uploadedScheduleState.isActive || !uploadedScheduleState.inPersonDays.length) {
    daySliderEl.classList.remove("visible");
    return;
  }

  const dayIndex = uploadedScheduleState.inPersonDays.indexOf(uploadedScheduleState.selectedDay);
  dayLabelEl.textContent = formatScheduleDay(uploadedScheduleState.selectedDay);
  daySliderEl.classList.add("visible");
  dayPrevEl.disabled = dayIndex <= 0;
  dayNextEl.disabled = dayIndex >= uploadedScheduleState.inPersonDays.length - 1;
}

function scheduleForSelectedDay() {
  if (!uploadedScheduleState.isActive || !uploadedScheduleState.selectedDay) {
    return sortScheduleChronologically(collectSchedule());
  }
  return sortScheduleChronologically(
    uploadedScheduleState.allEntries.filter((entry) => entry.days.includes(uploadedScheduleState.selectedDay))
  );
}

function displaySelectedDaySchedule() {
  const daySchedule = scheduleForSelectedDay();
  trimRowsToMax(daySchedule.length);
  while (getRows().length < daySchedule.length) {
    scheduleFormEl.appendChild(createCourseRow());
  }
  updateRowsWithSchedule(daySchedule);
}

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.add("visible");
  statusEl.style.color = isError ? "var(--danger)" : "var(--accent3)";
}

function renderBuildings(buildings) {
  if (!buildings.length) {
    buildingResultsEl.innerHTML = "<div class='card visible'>No building matches yet.</div>";
    return;
  }

  buildingResultsEl.innerHTML = buildings
    .map(
      (b, index) => `
        <div class="card visible" style="transition-delay:${index * 60}ms">
          <div class="card-icon" style="background: rgba(56,189,248,0.12); border: 1px solid rgba(56,189,248,0.18);">📍</div>
          <div class="card-info">
            <div class="card-name">${b.code} — ${b.name}</div>
            <div class="card-sub">${b.address}</div>
          </div>
          <div class="card-tag" style="background: rgba(52,211,153,0.12); color: #34d399;">
            STOP ${index + 1}
          </div>
        </div>
      `
    )
    .join("");
}

function renderFallbackRoute(buildings, schedule) {
  if (!buildings.length) {
    routeFallbackEl.textContent = "Add valid building codes to see a route summary.";
    return;
  }

  const orderedCodes = schedule.map((s) => s.building).filter(Boolean);
  const stops = orderedCodes.length
    ? orderedCodes.join(" → ")
    : buildings.map((b) => b.code).join(" → ");

  routeFallbackEl.innerHTML = `<strong>Route:</strong> ${stops}`;
}

function formatDurationFromSeconds(totalSeconds) {
  if (typeof totalSeconds !== "number" || Number.isNaN(totalSeconds)) return "Unknown";
  const minutes = Math.round(totalSeconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem ? `${hours} hr ${rem} min` : `${hours} hr`;
}

function parseDurationSeconds(duration) {
  if (!duration || typeof duration !== "string") return null;
  const match = duration.match(/^(\d+(?:\.\d+)?)s$/);
  if (!match) return null;
  return Math.round(parseFloat(match[1]));
}

function formatDistance(distanceMeters) {
  if (typeof distanceMeters !== "number") return "Unknown";
  const miles = distanceMeters / 1609.344;
  return `${miles.toFixed(2)} mi`;
}

function normalizeHexColor(hexColor) {
  const clean = hexColor.replace("#", "");
  if (clean.length === 3) {
    return clean.split("").map((ch) => ch + ch).join("");
  }
  return clean;
}

function getContrastTextColor(hexColor) {
  const normalized = normalizeHexColor(hexColor);
  const r = parseInt(normalized.slice(0, 2), 16);
  const g = parseInt(normalized.slice(2, 4), 16);
  const b = parseInt(normalized.slice(4, 6), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 160 ? "#111827" : "#F9FAFB";
}

function hashString(value) {
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
  }
  return Math.abs(hash);
}

function buildLegKey(fromBuilding, toBuilding, index) {
  const fromCode = fromBuilding?.code || `FROM_${index}`;
  const toCode = toBuilding?.code || `TO_${index + 1}`;
  return `${fromCode}->${toCode}#${index}`;
}

function assignStableRouteColors(legKeys) {
  const assigned = {};
  const used = new Set();
  const candidates = [...ROUTE_COLOR_PALETTE, ...ROUTE_FALLBACK_COLORS];

  legKeys.forEach((key, index) => {
    let preferred = routeColorCache.get(key);
    if (preferred && !used.has(preferred)) {
      assigned[key] = preferred;
      used.add(preferred);
      return;
    }

    const start = hashString(key) % candidates.length;
    let selected = null;
    for (let offset = 0; offset < candidates.length; offset += 1) {
      const color = candidates[(start + offset) % candidates.length];
      if (!used.has(color)) {
        selected = color;
        break;
      }
    }

    if (!selected) {
      selected = candidates[index % candidates.length];
    }

    routeColorCache.set(key, selected);
    assigned[key] = selected;
    used.add(selected);
  });

  return assigned;
}

function parseTimeToMinutes(timeStr) {
  if (!timeStr) return null;

  const clean = timeStr.trim().toUpperCase();
  const match = clean.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const meridiem = match[3];

  if (hours === 12) hours = 0;
  if (meridiem === "PM") hours += 12;

  return hours * 60 + minutes;
}

function minutesToDisplay(totalMinutes) {
  if (typeof totalMinutes !== "number" || Number.isNaN(totalMinutes)) return "Unknown";
  let hours = Math.floor(totalMinutes / 60);
  let minutes = totalMinutes % 60;
  const meridiem = hours >= 12 ? "PM" : "AM";
  let displayHour = hours % 12;
  if (displayHour === 0) displayHour = 12;
  return `${displayHour}:${String(minutes).padStart(2, "0")} ${meridiem}`;
}

function renderRouteDetails(routeData, buildings, schedule, legColors = {}) {
  if (!routeData || !routeData.polyline) {
    routeResultsEl.innerHTML = "<div class='card visible'>No route metrics available.</div>";
    return;
  }

  const mode =
    routeData.travel_mode === "WALK"
      ? "Walking"
      : routeData.travel_mode === "DRIVE"
        ? "Driving (fallback)"
        : "Unknown";

  const totalDurationSeconds = parseDurationSeconds(routeData.duration);
  const totalDistance = formatDistance(routeData.distance_meters);
  const totalDuration = formatDurationFromSeconds(totalDurationSeconds);
  const legs = Array.isArray(routeData.legs) ? routeData.legs : [];

  const summaryCard = `
    <div class="card visible" style="display:block;">
      <h4 style="margin-bottom:10px;">Route details</h4>
      <div><strong>Mode:</strong> ${mode}</div>
      <div><strong>Total distance:</strong> ${totalDistance}</div>
      <div><strong>Total travel time:</strong> ${totalDuration}</div>
      ${routeData.warning ? `<div style="margin-top:8px; color: var(--gold);">${routeData.warning}</div>` : ""}
    </div>
  `;

  if (!legs.length || buildings.length < 2) {
    routeResultsEl.innerHTML = summaryCard;
    return;
  }

  const legCards = legs.map((leg, index) => {
    const fromBuilding = buildings[index];
    const toBuilding = buildings[index + 1];
    const legKey = buildLegKey(fromBuilding, toBuilding, index);
    const legColor = legColors[legKey] || ROUTE_COLOR_PALETTE[index % ROUTE_COLOR_PALETTE.length];
    const legTextColor = getContrastTextColor(legColor);
    const legSeconds = parseDurationSeconds(leg.duration);
    const legMinutes = legSeconds == null ? null : Math.round(legSeconds / 60);
    const legDistance = formatDistance(leg.distance_meters);

    let bufferHtml = `<div style="color: var(--muted);">Buffer unavailable</div>`;

    const currentClass = schedule[index];
    const nextClass = schedule[index + 1];
    const currentStart = parseTimeToMinutes(currentClass?.start || "");
    const nextStart = parseTimeToMinutes(nextClass?.start || "");

    if (currentStart != null && nextStart != null && legMinutes != null) {
      const assumedClassMinutes = 75;
      const leaveTime = currentStart + assumedClassMinutes;
      const arrivalTime = leaveTime + legMinutes;
      const buffer = nextStart - arrivalTime;

      let bufferColor = "var(--accent3)";
      let bufferLabel = `${buffer} min to spare`;

      if (buffer < 0) {
        bufferColor = "var(--danger)";
        bufferLabel = `${Math.abs(buffer)} min late`;
      } else if (buffer < 10) {
        bufferColor = "var(--gold)";
      }

      bufferHtml = `
        <div style="margin-top:6px; color:${bufferColor}; font-weight:700;">
          Buffer: ${bufferLabel}
        </div>
        <div style="color: var(--muted); font-size: 0.72rem; margin-top:4px;">
          Assuming you leave ${fromBuilding.code} at ${minutesToDisplay(leaveTime)} and arrive at ${minutesToDisplay(arrivalTime)}.
        </div>
      `;
    }

    return `
      <div class="card visible" style="display:block;">
        <div class="route-step">
          <div class="step-arrow" style="background:${legColor}; color:${legTextColor}; border:1px solid ${legColor};">→</div>
          <div>
            <div class="card-name">${fromBuilding.code} → ${toBuilding.code}</div>
            <div class="card-sub">${legDistance} · ${legMinutes == null ? "Unknown" : `${legMinutes} min`}</div>
            ${bufferHtml}
          </div>
        </div>
      </div>
    `;
  }).join("");

  routeResultsEl.innerHTML = summaryCard + legCards;
}

async function fetchJSON(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    // ignore
  }

  if (!response.ok) {
    const message = data?.error || `Request failed: ${response.status}`;
    throw new Error(message);
  }

  return data;
}

function clearMap() {
  markers.forEach((marker) => marker.setMap(null));
  markers = [];

  currentPolylines.forEach((polyline) => polyline.setMap(null));
  currentPolylines = [];

  routeResultsEl.innerHTML = "";
}

function setupMap(center) {
  if (!map) return;
  map.setCenter(center);
  map.setZoom(16);
}

function addMarkers(buildings) {
  if (!map) return;

  buildings.forEach((b, index) => {
    const marker = new google.maps.Marker({
      position: { lat: b.lat, lng: b.lng },
      map,
      title: `${b.code} - ${b.name}`,
      label: {
        text: String(index + 1),
        color: "white",
        fontWeight: "bold",
      },
    });

    const infoWindow = new google.maps.InfoWindow({
      content: `<strong>${b.code}</strong><br>${b.name}<br><small>${b.address}</small>`,
    });

    marker.addListener("click", () => {
      infoWindow.open(map, marker);
    });

    markers.push(marker);
  });
}

// Local polyline decoder so we do NOT depend on google.maps.geometry
function decodePolyline(encoded) {
  let index = 0;
  const len = encoded.length;
  let lat = 0;
  let lng = 0;
  const path = [];

  while (index < len) {
    let result = 0;
    let shift = 0;
    let b;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlat = (result & 1) ? ~(result >> 1) : (result >> 1);
    lat += dlat;

    result = 0;
    shift = 0;

    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);

    const dlng = (result & 1) ? ~(result >> 1) : (result >> 1);
    lng += dlng;

    path.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }

  return path;
}

function drawPolylines(legPolylines, legColors, legKeys) {
  if (!map || !legPolylines.length) return;
  currentPolylines.forEach((polyline) => polyline.setMap(null));
  currentPolylines = [];
  const bounds = new google.maps.LatLngBounds();

  legPolylines.forEach((encodedPolyline, index) => {
    if (!encodedPolyline) return;
    const path = decodePolyline(encodedPolyline);
    const legKey = legKeys[index];
    const strokeColor = legColors[legKey] || ROUTE_COLOR_PALETTE[index % ROUTE_COLOR_PALETTE.length];
    const polyline = new google.maps.Polyline({
      path,
      map,
      strokeColor,
      strokeWeight: 6,
      strokeOpacity: 0.88,
    });
    currentPolylines.push(polyline);
    path.forEach((point) => bounds.extend(point));
  });

  if (currentPolylines.length === 0) return;
  map.fitBounds(bounds, 80);
}

async function renderDirections(buildings, schedule, buildRunId) {
  if (buildRunId !== latestBuildRunId) return;

  if (buildings.length < 2) {
    currentRouteData = null;
    routeResultsEl.innerHTML = "<div class='card visible'>Add at least 2 valid buildings to see a route.</div>";
    return;
  }

  let data = null;
  if (uploadedScheduleState.isActive && uploadedScheduleState.selectedDay) {
    const cached = routeCacheByDay.get(uploadedScheduleState.selectedDay);
    data = cached || null;
  }
  if (!data) {
    data = await fetchJSON("/api/route", { buildings });
    if (buildRunId !== latestBuildRunId) return;
    if (uploadedScheduleState.isActive && uploadedScheduleState.selectedDay) {
      routeCacheByDay.set(uploadedScheduleState.selectedDay, data);
    }
  }

  currentRouteData = data;
  const legs = Array.isArray(data.legs) ? data.legs : [];
  const legKeys = legs.map((_, index) => buildLegKey(buildings[index], buildings[index + 1], index));
  const legColors = assignStableRouteColors(legKeys);
  const legPolylines = legs.map((leg) => leg.polyline).filter(Boolean);
  const fallbackLegPolylines = legPolylines.length ? legPolylines : (data.polyline ? [data.polyline] : []);
  const fallbackLegKeys = legKeys.length ? legKeys : [buildLegKey(buildings[0], buildings[buildings.length - 1], 0)];

  drawPolylines(fallbackLegPolylines, legColors, fallbackLegKeys);
  renderRouteDetails(data, buildings, schedule, legColors);
}

async function buildDemo() {
  if (!mapReady) {
    pendingMapAction = buildDemo;
    setStatus("Waiting for map to load...");
    return;
  }

  const buildRunId = ++latestBuildRunId;
  const schedule = scheduleForSelectedDay();
  updateRowsWithSchedule(schedule);
  const courses = schedule.map((s) => s.course).filter(Boolean);
  const inPersonSchedule = schedule.filter((entry) => isInPersonClass(entry));
  const buildings = inPersonSchedule.map((s) => s.building).filter(Boolean);

  if (!courses.length && !buildings.length) {
    setStatus("Enter at least one course or building.", true);
    return;
  }

  setStatus("Building your campus day...");

  try {
    const [buildingData, summaryData] = await Promise.all([
      fetchJSON("/api/buildings", { buildings }),
      fetchJSON("/api/course-summary", { courses, schedule }),
    ]);
    if (buildRunId !== latestBuildRunId) return;

    const foundBuildings = buildingData.found || [];
    const missingBuildings = buildingData.missing || [];

    const sortedBuildings = sortBuildingsByTime(foundBuildings, inPersonSchedule);

    renderBuildings(sortedBuildings);
    summaryEl.textContent = summaryData.summary || "No summary generated.";
    summaryEl.classList.add("loaded");
    renderFallbackRoute(sortedBuildings, inPersonSchedule);

    clearMap();

    if (sortedBuildings.length) {
      const spacedBuildings = offsetDuplicateMarkers(sortedBuildings);

      setupMap({ lat: spacedBuildings[0].lat, lng: spacedBuildings[0].lng });
      addMarkers(spacedBuildings);
      await renderDirections(spacedBuildings, inPersonSchedule, buildRunId);
    } else {
      routeResultsEl.innerHTML = "<div class='card visible'>No valid buildings were found.</div>";
    }

    if (missingBuildings.length) {
      setStatus(`Built demo day. Missing building codes: ${missingBuildings.join(", ")}`, true);
    } else {
      setStatus("Built demo day successfully.");
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Something went wrong while building the demo.", true);
    routeResultsEl.innerHTML = `<div class='card visible'>${error.message || "Route service could not find a path."}</div>`;
  }
}

function loadExample() {
  clearUploadedState();
  trimRowsToMax(EXAMPLE_SCHEDULE.length);

  while (getRows().length < EXAMPLE_SCHEDULE.length) {
    scheduleFormEl.appendChild(createCourseRow());
  }

  getRows().forEach((row, index) => {
    row.querySelector(".course").value = EXAMPLE_SCHEDULE[index]?.course || "";
    row.querySelector(".building").value = EXAMPLE_SCHEDULE[index]?.building || "";
    row.querySelector(".time").value = EXAMPLE_SCHEDULE[index]?.start || "";
  });

  setStatus("Loaded example schedule.");
}

async function handleImageUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const base64 = reader.result.split(",")[1];
      const mediaType = file.type;

      setStatus("Reading your schedule...");
      const data = await fetchJSON("/api/parse-schedule-image", {
        image: base64,
        media_type: mediaType
      });

      const parsedEntries = Array.isArray(data.schedule) ? data.schedule.map(normalizeScheduleEntry) : [];
      const inPersonDays = DAY_SEQUENCE.filter((day) =>
        parsedEntries.some((entry) => entry.days.includes(day) && isInPersonClass(entry))
      );
      const selectedDay = inPersonDays[0] || DAY_SEQUENCE.find((day) => parsedEntries.some((entry) => entry.days.includes(day))) || "";

      clearUploadedState();
      uploadedScheduleState.isActive = true;
      uploadedScheduleState.allEntries = parsedEntries;
      uploadedScheduleState.inPersonDays = inPersonDays;
      uploadedScheduleState.selectedDay = selectedDay;
      saveUploadedState();
      renderDaySlider();
      displaySelectedDaySchedule();
      await buildDemo();

      setStatus("Schedule loaded from image! Use arrows to switch days.");
    } catch (error) {
      console.error(error);
      setStatus("Could not read schedule image. Please try again.", true);
    }
  };
  reader.readAsDataURL(file);
}

const scheduleUploadInput = document.getElementById("schedule-upload");
if (scheduleUploadInput) {
  scheduleUploadInput.addEventListener("change", handleImageUpload);
}

function rotateDay(delta) {
  if (!uploadedScheduleState.isActive || !uploadedScheduleState.inPersonDays.length) return;
  const currentIndex = uploadedScheduleState.inPersonDays.indexOf(uploadedScheduleState.selectedDay);
  if (currentIndex < 0) return;
  const nextIndex = currentIndex + delta;
  if (nextIndex < 0 || nextIndex >= uploadedScheduleState.inPersonDays.length) return;

  uploadedScheduleState.selectedDay = uploadedScheduleState.inPersonDays[nextIndex];
  saveUploadedState();
  renderDaySlider();
  displaySelectedDaySchedule();
  buildDemo();
}

dayPrevEl.addEventListener("click", () => rotateDay(-1));
dayNextEl.addEventListener("click", () => rotateDay(1));

runButton.addEventListener("click", buildDemo);
loadExampleButton.addEventListener("click", loadExample);
addCourseButton.addEventListener("click", addCourseRow);
loadExample();

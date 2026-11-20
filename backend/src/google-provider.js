import { createHash } from "node:crypto";

const ROUTES_ENDPOINT = "https://googleapis.com";
const PLACES_ENDPOINT = "https://googleapis.com";

class GoogleProviderError extends Error {
  constructor(code, message, { retryable = true } = {}) {
    super(message);
    this.name = "GoogleProviderError";
    this.code = code;
    this.retryable = retryable;
  }
}

function rounded(value, digits = 7) {
  return Number(Number(value).toFixed(digits));
}

function compactText(value, maxLen) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, maxLen);
}

// Decodes Google's encoded polyline into [{ longitude_deg, latitude_deg }]
function decodePolyline(encoded) {
  if (!encoded || typeof encoded !== "string") return [];
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({
      longitude_deg: rounded(lng / 1e5, 7),
      latitude_deg: rounded(lat / 1e5, 7),
    });
  }
  return points;
}

function mapGoogleManeuver(maneuver = "", instruction = "") {
  const m = String(maneuver).toUpperCase();
  const text = String(instruction).toLowerCase();

  if (text.includes("destination") || text.includes("arrive")) return "arrive";
  if (m === "ROUNDABOUT_LEFT" || m === "ROUNDABOUT_RIGHT") return "roundabout";
  if (m === "UTURN_RIGHT") return "u_turn_right";
  if (m === "UTURN_LEFT") return "u_turn_left";
  if (m === "TURN_SLIGHT_RIGHT" || m === "KEEP_RIGHT" || m === "RAMP_RIGHT" || m === "FORK_RIGHT") return "slight_right";
  if (m === "TURN_SLIGHT_LEFT" || m === "KEEP_LEFT" || m === "RAMP_LEFT" || m === "FORK_LEFT") return "slight_left";
  if (m === "TURN_SHARP_RIGHT") return "sharp_right";
  if (m === "TURN_SHARP_LEFT") return "sharp_left";
  if (m === "TURN_RIGHT") return "right";
  if (m === "TURN_LEFT") return "left";
  if (m === "DEPART" || m === "STRAIGHT" || m === "MERGE") return "continue";
  return "unknown";
}

function mapTrafficSpeed(speed = "") {
  const s = String(speed).toUpperCase();
  if (s === "TRAFFIC_JAM") return "severe";
  if (s === "SLOW") return "slow";
  if (s === "NORMAL") return "free_flow";
  return "unknown";
}

function distanceMetres(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude_deg - a.latitude_deg);
  const dLon = toRad(b.longitude_deg - a.longitude_deg);
  const lat1 = toRad(a.latitude_deg);
  const lat2 = toRad(b.latitude_deg);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h)));
}

function transformGoogleRoute(route, generatedAtMs) {
  const leg = route.legs?.[0];
  if (!leg) throw new GoogleProviderError("NO_ROUTE", "Google returned no route legs", { retryable: false });

  const polyline = decodePolyline(route.polyline?.encodedPolyline);
  if (polyline.length < 2) {
    throw new GoogleProviderError("INVALID_POLYLINE", "Google route has fewer than 2 polyline points", { retryable: false });
  }

  const maneuvers = [];
  let offsetM = 0;
  const steps = Array.isArray(leg.steps) ? leg.steps : [];

  for (const [index, step] of steps.entries()) {
    const stepDistM = Math.max(0, Number(step.distanceMeters ?? 0));
    const nav = step.navigationInstruction ?? {};
    const instruction = compactText(nav.instructions, 256);
    const roadMatch = instruction.match(/(?:onto|on|toward|towards)\s+([^,(\n]+)/i);
    const roadName = compactText(roadMatch ? roadMatch[1] : instruction, 96);

    maneuvers.push({
      id: index + 1,
      type: mapGoogleManeuver(nav.maneuver, instruction),
      route_offset_m: rounded(offsetM + stepDistM, 2),
      road_name: roadName,
      instruction,
      roundabout_exit: 0,
    });
    offsetM += stepDistM;
  }

  // Ensure final arrival maneuver exists
  if (maneuvers.length > 0 && maneuvers.at(-1).type !== "arrive") {
    maneuvers.push({
      id: maneuvers.length + 1,
      type: "arrive",
      route_offset_m: rounded(offsetM, 2),
      road_name: "",
      instruction: "Arrive at destination",
      roundabout_exit: 0,
    });
  }

  const totalDistanceM = Math.max(0, Number(route.distanceMeters ?? offsetM));
  const totalDurationS = Math.round(parseFloat(String(route.duration ?? "0s").replace("s", "")) || 0);

  // Map traffic speed intervals if present
  const traffic = [];
  const intervals = route.travelAdvisory?.speedReadingIntervals ?? [];
  for (const interval of intervals) {
    const startIdx = Number(interval.startPolylinePointIndex ?? 0);
    const endIdx = Number(interval.endPolylinePointIndex ?? 0);
    if (polyline.length > 1 && endIdx > startIdx) {
      traffic.push({
        start_offset_m: rounded((startIdx / (polyline.length - 1)) * totalDistanceM, 2),
        end_offset_m: rounded((endIdx / (polyline.length - 1)) * totalDistanceM, 2),
        level: mapTrafficSpeed(interval.speed),
      });
    }
  }

  const sig = JSON.stringify({ totalDistanceM, totalDurationS, start: polyline[0], end: polyline.at(-1) });
  const routeId = `google-${createHash("sha256").update(sig).digest("hex").slice(0, 20)}`;

  return {
    schema_version: 1,
    route_id: routeId,
    provider: "google",
    coordinate_system: "WGS84",
    generated_at_ms: Math.trunc(generatedAtMs),
    total_distance_m: rounded(totalDistanceM, 2),
    total_duration_s: totalDurationS,
    polyline,
    maneuvers,
    traffic,
  };
}

export function createGoogleProvider({ key, fetchImpl = globalThis.fetch, clock = Date.now } = {}) {
  if (typeof key !== "string" || !key.trim()) {
    throw new GoogleProviderError("SERVER_MISCONFIGURED", "GOOGLE_MAPS_API_KEY is required", { retryable: false });
  }

  async function computeGoogleRoutes(request, { computeAlternativeRoutes = false, signal } = {}) {
    const body = {
      origin: {
        location: {
          latLng: { latitude: Number(request.origin.latitude_deg), longitude: Number(request.origin.longitude_deg) },
        },
      },
      destination: {
        location: {
          latLng: { latitude: Number(request.destination.latitude_deg), longitude: Number(request.destination.longitude_deg) },
        },
      },
      travelMode: "TWO_WHEELER",
      routingPreference: "TRAFFIC_AWARE",
      computeAlternativeRoutes,
      polylineQuality: "HIGH_QUALITY",
      languageCode: "en-US",
      units: "METRIC",
    };

    const response = await fetchImpl(ROUTES_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask":
          "routes.distanceMeters,routes.duration,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction,routes.travelAdvisory.speedReadingIntervals",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new GoogleProviderError("PROVIDER_HTTP_ERROR", `Google Routes returned HTTP ${response.status}`, {
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    const payload = await response.json();
    if (!Array.isArray(payload.routes) || payload.routes.length === 0) {
      throw new GoogleProviderError("NO_ROUTE", "Google returned no motorcycle routes", { retryable: false });
    }
    return payload.routes;
  }

  return {
    async planRoute(request, options = {}) {
      const routes = await computeGoogleRoutes(request, { computeAlternativeRoutes: false, signal: options.signal });
      return transformGoogleRoute(routes[0], clock());
    },

    async planRouteOptions(request, options = {}) {
      const routes = await computeGoogleRoutes(request, { computeAlternativeRoutes: true, signal: options.signal });
      const now = clock();
      return routes.slice(0, 3).map((r) => transformGoogleRoute(r, now));
    },

    async searchPlaces(query, { signal } = {}) {
      const keywords = compactText(query?.keywords, 80);
      const body = {
        textQuery: keywords,
        maxResultCount: 12,
        languageCode: "en",
      };

      if (query?.origin) {
        body.locationBias = {
          circle: {
            center: {
              latitude: Number(query.origin.latitude_deg),
              longitude: Number(query.origin.longitude_deg),
            },
            radius: 50000.0,
          },
        };
      }

      const response = await fetchImpl(PLACES_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": key,
          "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        throw new GoogleProviderError("PROVIDER_HTTP_ERROR", `Google Places returned HTTP ${response.status}`, {
          retryable: response.status >= 500 || response.status === 429,
        });
      }

      const payload = await response.json();
      const rawPlaces = Array.isArray(payload.places) ? payload.places : [];
      const places = rawPlaces
        .filter((p) => p.location && Number.isFinite(p.location.latitude) && Number.isFinite(p.location.longitude))
        .map((p) => {
          const point = {
            longitude_deg: rounded(p.location.longitude, 7),
            latitude_deg: rounded(p.location.latitude, 7),
          };
const address = compactText(p.formattedAddress, 160);
const parts = address.split(",").map((s) => s.trim());
const city = compactText(parts.at(-2) ?? "", 32);
const district = compactText(parts.at(-3) ?? "", 32);
const item = {
id: compactText(p.id, 64),
name: compactText(p.displayName?.text, 96),
address,
city,
district,
display_area: [district, city].filter(Boolean).join(" · "),
location: point,
};
if (query?.origin) item.distance_m = distanceMetres(query.origin, point);
return item;
});
return {
protocol_version: 1,
query: keywords,
places,
};
},
};
}

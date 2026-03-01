import express, { Request, Response } from "express";


// ---------- Safety settings ----------
const SAFETY = {
  SEGMENT_VISIBLE_RADIUS_M: 1200,
  JITTER_METERS: 30,

  // D) Auto-expire
  RAW_TTL_MIN: 60,
  CLEANUP_EVERY_MIN: 5,

  // A) Cooldown
  DEVICE_SEGMENT_COOLDOWN_SEC: 300 // 5 minutes
};
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function getDeviceId(req: Request) {
  const fromHeader = req.headers["x-device-id"];
  if (typeof fromHeader === "string" && fromHeader.length >= 6) return fromHeader;
  return req.ip; // fallback
}

function jitterLatLng(lat: number, lng: number, seed: string, jitterM: number) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = (h ^ seed.charCodeAt(i)) * 16777619;

  const rand01 = (x: number) => {
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return ((x >>> 0) % 10000) / 10000;
  };

  const r1 = rand01(h);
  const r2 = rand01(h ^ 0x9e3779b9);

  const dLat = (jitterM * (r1 - 0.5)) / 111111;
  const dLng = (jitterM * (r2 - 0.5)) / (111111 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

function freshnessBucket(ageMin: number) {
  if (ageMin < 10) return "<10m";
  if (ageMin < 30) return "10–30m";
  if (ageMin < 60) return "30–60m";
  return "old";
}

// ---------- In-memory MVP store (temporary) ----------
// Later we’ll replace with Postgres + Redis in the cloud.
type Segment = {
  id: string;
  centerLat: number;
  centerLng: number;
  score: number;         // -1..+1
  lastUpdatedAt: number; // epoch ms
};

const segments = new Map<string, Segment>();

function segmentIdFor(lat: number, lng: number) {
  // grid-based segment id (MVP). Later OSRM + street segment snap.
  return `${lat.toFixed(3)}:${lng.toFixed(3)}`;
}

function updateSegment(lat: number, lng: number, status: "AVAILABLE" | "TAKEN") {
  const id = segmentIdFor(lat, lng);
  const now = Date.now();
  const existing = segments.get(id);

  // simple score update: move toward +1 if available, toward -1 if taken
  const delta = status === "AVAILABLE" ? 0.25 : -0.25;
  const nextScore = Math.max(-1, Math.min(1, (existing?.score ?? 0) + delta));

  const seg: Segment = {
    id,
    centerLat: existing?.centerLat ?? lat,
    centerLng: existing?.centerLng ?? lng,
    score: nextScore,
    lastUpdatedAt: now,
  };

  segments.set(id, seg);
  return seg;
}

// A) Cooldown store: key = `${deviceId}:${segmentId}` => lastReportEpochMs
const lastReportByDeviceSegment = new Map<string, number>();

// ---------- App ----------
const app = express();
app.use(express.json());

// --- CORS (allow browser requests) ---
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Device-Id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

// Test endpoint (keep for now)
app.post("/reports", (req: Request, res: Response) => {
  const lat = req.body?.lat;
  const lng = req.body?.lng;
  const status = req.body?.status;

  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    (status !== "AVAILABLE" && status !== "TAKEN")
  ) {
    return res.status(400).json({ error: "Invalid input. Expected { lat:number, lng:number, status:'AVAILABLE'|'TAKEN' }" });
  }
  const deviceId = getDeviceId(req);
  const segId = segmentIdFor(lat, lng); // same id we will update
  const key = `${deviceId}:${segId}`;
  const now = Date.now();

  const last = lastReportByDeviceSegment.get(key);
  if (last && now - last < SAFETY.DEVICE_SEGMENT_COOLDOWN_SEC * 1000) {
    const retryInSec = Math.ceil((SAFETY.DEVICE_SEGMENT_COOLDOWN_SEC * 1000 - (now - last)) / 1000);
    return res.status(429).json({
      error: "Cooldown active for this block.",
      retryInSeconds: retryInSec
    });
  }

  lastReportByDeviceSegment.set(key, now);

  const seg = updateSegment(lat, lng, status);

  // Return only segment-level info (privacy)
  const ageMin = (Date.now() - seg.lastUpdatedAt) / 60_000;
  const bucket = freshnessBucket(ageMin);
  const j = jitterLatLng(seg.centerLat, seg.centerLng, seg.id, SAFETY.JITTER_METERS);

  return res.json({
    segment: {
      id: seg.id,
      displayLat: j.lat,
      displayLng: j.lng,
      score: seg.score,
      freshness: bucket,
    },
  });
});

// GET /segments/nearby (safe visibility: must provide user location)
app.get("/segments/nearby", (req: Request, res: Response) => {
  const userLat = Number(req.query.userLat);
  const userLng = Number(req.query.userLng);
  const minLat = Number(req.query.minLat);
  const maxLat = Number(req.query.maxLat);
  const minLng = Number(req.query.minLng);
  const maxLng = Number(req.query.maxLng);

  if (
    isNaN(userLat) || isNaN(userLng) ||
    isNaN(minLat) || isNaN(maxLat) ||
    isNaN(minLng) || isNaN(maxLng)
  ) {
    return res.status(400).json({ error: "Invalid query parameters" });
  }

  const now = Date.now();

  const out = Array.from(segments.values())
    .filter((s) =>
      s.centerLat >= minLat &&
      s.centerLat <= maxLat &&
      s.centerLng >= minLng &&
      s.centerLng <= maxLng
    )
    .filter((s) =>
      haversineM(userLat, userLng, s.centerLat, s.centerLng) <= SAFETY.SEGMENT_VISIBLE_RADIUS_M
    )
    .map((s) => {
      const ageMin = (now - s.lastUpdatedAt) / 60_000;
      const bucket = freshnessBucket(ageMin);
      if (bucket === "old") return null;

      const j = jitterLatLng(s.centerLat, s.centerLng, s.id, SAFETY.JITTER_METERS);

      return {
        id: s.id,
        displayLat: j.lat,
        displayLng: j.lng,
        score: s.score,
        freshness: bucket,
      };
    })
    .filter(Boolean);

  res.json({ segments: out });
});

// D) Cleanup job: remove stale segments
function startCleanupJob() {
  setInterval(() => {
    const cutoff = Date.now() - SAFETY.RAW_TTL_MIN * 60_000;
    let removed = 0;

    // prune cooldown entries
    for (const [k, ts] of lastReportByDeviceSegment.entries()) {
      if (ts < cutoff) lastReportByDeviceSegment.delete(k);
    }

    for (const [id, seg] of segments.entries()) {
      if (seg.lastUpdatedAt < cutoff) {
        segments.delete(id);
        removed++;
      }
    }
    
  // prune cooldown entries older than TTL
  for (const [k, ts] of lastReportByDeviceSegment.entries()) {
    if (ts < cutoff) lastReportByDeviceSegment.delete(k);
  }
    if (removed > 0) {
      console.log(`[cleanup] removed ${removed} stale segment(s)`);
    }
  }, SAFETY.CLEANUP_EVERY_MIN * 60_000);
  
}

// Start background jobs BEFORE listening
startCleanupJob();

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});
import express from "express";
import rateLimit from "express-rate-limit";

const app = express();
const PORT = process.env.PORT || 3000;

// ===== CONFIG =====
const TARGET_BASE = (process.env.TARGET_DOMAIN || "").replace(/\/$/, "");
const API_KEY = process.env.API_KEY || null;
app.set("trust proxy", 1);
// ===== RATE LIMIT =====
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
}));

// ===== BODY =====
app.use(express.raw({ type: "*/*", limit: "20mb" }));

// ===== CORS =====
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "*");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

// ===== OPTIONAL API KEY =====
app.use((req, res, next) => {
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(403).send("Forbidden");
  }
  next();
});

// ===== SIMPLE CACHE =====
const cache = new Map();

function getCacheKey(req) {
  return req.method + ":" + req.originalUrl;
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expire) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

function setCache(key, data, ttl = 5000) {
  cache.set(key, {
    data,
    expire: Date.now() + ttl,
  });
}

// ===== HEADER FILTER =====
const STRIP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

// ===== FETCH HELPERS =====
async function fetchWithTimeout(url, options, timeout = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

async function safeFetch(url, options) {
  try {
    return await fetchWithTimeout(url, options);
  } catch {
    return await fetchWithTimeout(url, options);
  }
}

// ===== MAIN PROXY =====
app.all("*", async (req, res) => {
  if (!TARGET_BASE) {
    return res.status(500).send("TARGET_DOMAIN not set");
  }

  try {
    const targetUrl = TARGET_BASE + req.originalUrl;

    // ===== CACHE CHECK =====
    if (req.method === "GET") {
      const cached = getCache(getCacheKey(req));
      if (cached) {
        return res.send(cached);
      }
    }

    const headers = {};
    let clientIp = null;

    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();

      if (STRIP_HEADERS.has(key)) continue;
      if (key.startsWith("x-vercel-")) continue;

      if (key === "x-real-ip") {
        clientIp = v;
        continue;
      }

      if (key === "x-forwarded-for") {
        if (!clientIp) clientIp = v;
        continue;
      }

      headers[key] = v;
    }

    if (clientIp) headers["x-forwarded-for"] = clientIp;

    const hasBody = !["GET", "HEAD"].includes(req.method);

    const response = await safeFetch(targetUrl, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      redirect: "manual",
    });

    if (response.status === 429) {
      return res.status(429).send("Upstream rate limited");
    }

    res.status(response.status);

    response.headers.forEach((value, key) => {
      if (key.toLowerCase() === "content-encoding") return;
      res.setHeader(key, value);
    });

    const buffer = Buffer.from(await response.arrayBuffer());

    if (req.method === "GET" && response.status === 200) {
      setCache(getCacheKey(req), buffer);
    }

    res.send(buffer);

  } catch (err) {
    console.error("Proxy error:", err);
    res.status(502).send("Bad Gateway");
  }
});

// ===== START =====
app.listen(PORT, () => {
  console.log(`Proxy running on port ${PORT}`);
});

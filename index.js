import http from "http";


const TARGET_BASE = (process.env.TARGET_DOMAIN || "https://nima.feri2020.ir").replace(/\/$/, "");

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

const server = http.createServer(async (req, res) => {
  try {
    if (!TARGET_BASE) {
      res.writeHead(500);
      return res.end("TARGET_DOMAIN not set");
    }

    // 🔥 FIX: proper URL building
    const targetUrl = TARGET_BASE + req.url;

    const headers = {};
    let clientIp = req.socket.remoteAddress;

    for (const [k, v] of Object.entries(req.headers)) {
      const key = k.toLowerCase();

      if (STRIP_HEADERS.has(key)) continue;

      if (key === "x-forwarded-for") {
        clientIp = v;
        continue;
      }

      headers[key] = v;
    }

    if (clientIp) {
      headers["x-forwarded-for"] = clientIp;
    }

    const hasBody = req.method !== "GET" && req.method !== "HEAD";

    // 🔥 FIX: convert Node stream → fetch body
    const body = hasBody ? req : undefined;

    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    res.writeHead(response.status, Object.fromEntries(response.headers));

    if (!response.body) {
      const text = await response.text();
      return res.end(text);
    }

    const reader = response.body.getReader();

    const pump = async () => {
      const { done, value } = await reader.read();
      if (done) return res.end();
      res.write(Buffer.from(value));
      pump();
    };

    pump();

  } catch (err) {
    console.error("proxy error:", err);
    res.writeHead(502);
    res.end("Bad Gateway");
  }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log("Proxy running on port", PORT);
});

import express from "express";
import http from "http";
import { matchRouter } from "./routes/matches.js";
import { attachWebSocketServer } from "./ws/server.js";
import { httpArcjet } from "./ws/arcjet.js";

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

app.use(express.json());

// Arcjet runs before the routes so a denied request never touches the
// database. It fails OPEN: if Arcjet itself errors we log and continue,
// because a security-vendor outage should not take the whole API down.
app.use(async (req, res, next) => {
  if (!httpArcjet) return next();

  try {
    const decision = await httpArcjet.protect(req);

    if (decision.isDenied()) {
      if (decision.reason.isRateLimit()) {
        return res.status(429).json({ error: "Too many requests" });
      }
      if (decision.reason.isBot()) {
        return res.status(403).json({ error: "Automated traffic is not allowed" });
      }
      return res.status(403).json({ error: "Forbidden" });
    }

    next();
  } catch (error) {
    console.error("arcjet protect failed, allowing request", error);
    next();
  }
});

app.get("/", (req, res) => {
  res.json({ message: "Hello from the Express server!" });
});

app.use("/matches", matchRouter);

const { broadcastMatchCreated } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;


// Must be server.listen, not app.listen - app.listen() would create a
// second HTTP server, leaving the one the WebSocket server is attached to
// unused, so upgrade requests would never arrive.
server.listen(PORT, HOST, () => {
  const baseURL = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server is running on ${baseURL}`);
  console.log(`WebSocket server is running on ${baseURL.replace('http', 'ws')}/ws`);
});

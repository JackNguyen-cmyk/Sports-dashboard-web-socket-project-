import express from "express";
import http from "http";
import { matchRouter } from "./routes/matches.js";
import { attachWebSocketServer } from "./ws/server.js";
import { securityMiddleware } from "./ws/arcjet.js";
import { commentaryRouter } from "./routes/commentary.js";

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
const server = http.createServer(app);

app.use(express.json());

// Registered before any route: Express matches in order, so a route declared
// above this line would never reach it.
app.use(securityMiddleware());

app.get("/", (req, res) => {
  res.json({ message: "Hello from the Express server!" });
});

app.use("/matches", matchRouter);

app.use("/matches/:id/commentary", commentaryRouter);

const { broadcastMatchCreated, broadcastCommentaryCreated } = attachWebSocketServer(server);
app.locals.broadcastMatchCreated = broadcastMatchCreated;
app.locals.broadcastCommentaryCreated = broadcastCommentaryCreated;


// Must be server.listen, not app.listen - app.listen() would create a
// second HTTP server, leaving the one the WebSocket server is attached to
// unused, so upgrade requests would never arrive.
server.listen(PORT, HOST, () => {
  const baseURL = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server is running on ${baseURL}`);
  console.log(`WebSocket server is running on ${baseURL.replace('http', 'ws')}/ws`);
});

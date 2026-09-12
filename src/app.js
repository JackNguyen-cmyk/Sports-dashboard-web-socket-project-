import express from 'express';
import http from 'http';

import { matchRouter } from './routes/matches.js';
import { commentaryRouter } from './routes/commentary.js';
import { attachWebSocketServer } from './ws/server.js';
import { securityMiddleware } from './ws/arcjet.js';

/**
 * Builds the app and its HTTP server without listening. index.js calls this
 * and listens; a test calls it and listens on port 0.
 *
 * A factory rather than module-level `export const app`, because a module is
 * evaluated once per process - every test file would share one app, with no
 * way to hand a particular test a different dependency.
 */
export function createApp() {
  const app = express();
  const server = http.createServer(app);

  app.use(express.json());

  // Registered before any route: Express matches in order, so a route declared
  // above this line would never reach it.
  app.use(securityMiddleware());

  app.get('/', (req, res) => {
    res.json({ message: 'Hello from the Express server!' });
  });

  app.use('/matches', matchRouter);

  app.use('/matches/:id/commentary', commentaryRouter);

  // The routes reach the WebSocket layer through app.locals rather than by
  // importing it, so the HTTP side has no import-time dependency on ws.
  const { broadcastMatchCreated, broadcastCommentaryCreated } = attachWebSocketServer(server);
  app.locals.broadcastMatchCreated = broadcastMatchCreated;
  app.locals.broadcastCommentaryCreated = broadcastCommentaryCreated;

  return { app, server };
}

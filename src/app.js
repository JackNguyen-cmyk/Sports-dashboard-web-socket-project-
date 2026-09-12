import express from 'express';
import http from 'http';

import { createMatchRouter } from './routes/matches.js';
import { createCommentaryRouter } from './routes/commentary.js';
import { attachWebSocketServer } from './ws/server.js';
import { securityMiddleware } from './ws/arcjet.js';

/**
 * Builds the app and its HTTP server without listening. index.js calls this
 * with the real database and listens; a test calls it with a fake and listens
 * on port 0.
 *
 * A factory rather than module-level `export const app`, because a module is
 * evaluated once per process - every test file would share one app, with no
 * way to hand a particular test a different dependency.
 *
 * This file deliberately does not import db/db.js. The real database is wired
 * in by index.js and nowhere else, so nothing on the request path has an
 * import-time dependency on DATABASE_URL.
 */
export function createApp({ db } = {}) {
  // Fail at construction, not on the first request. Without this a missing db
  // surfaces as "cannot read properties of undefined" inside a handler - a
  // 500 to the client and a stack trace pointing at the wrong place.
  if (!db) {
    throw new Error('createApp requires a db');
  }

  const app = express();
  const server = http.createServer(app);

  app.use(express.json());

  // Registered before any route: Express matches in order, so a route declared
  // above this line would never reach it.
  app.use(securityMiddleware());

  app.get('/', (req, res) => {
    res.json({ message: 'Hello from the Express server!' });
  });

  app.use('/matches', createMatchRouter({ db }));

  app.use('/matches/:id/commentary', createCommentaryRouter({ db }));

  // The routes reach the WebSocket layer through app.locals rather than by
  // importing it, so the HTTP side has no import-time dependency on ws.
  const { broadcastMatchCreated, broadcastCommentaryCreated } = attachWebSocketServer(server);
  app.locals.broadcastMatchCreated = broadcastMatchCreated;
  app.locals.broadcastCommentaryCreated = broadcastCommentaryCreated;

  return { app, server };
}

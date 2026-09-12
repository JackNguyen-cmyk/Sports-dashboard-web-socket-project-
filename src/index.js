// dotenv first: the agent is configured from APMINSIGHT_* environment
// variables, and index.js does not otherwise import dotenv - it only worked
// because db/db.js happened to pull it in first. That is a hidden dependency
// on import order, so load it explicitly.
import 'dotenv/config';

// Then the agent, before app.js, since it instruments modules as they are
// imported and app.js is what pulls in express, pg and ws. ESM hoists every
// import, so this ordering is the ordering of the import statements, not of
// the code between them.
import AgentAPI from "apminsight";
AgentAPI.config();
import { createApp } from './app.js';

const PORT = Number(process.env.PORT) || 8000;
const HOST = process.env.HOST || '0.0.0.0';

const { server } = createApp();

// Must be server.listen, not app.listen - app.listen() would create a
// second HTTP server, leaving the one the WebSocket server is attached to
// unused, so upgrade requests would never arrive.
server.listen(PORT, HOST, () => {
  const baseURL = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
  console.log(`Server is running on ${baseURL}`);
  console.log(`WebSocket server is running on ${baseURL.replace('http', 'ws')}/ws`);
});

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { WebSocket } from 'ws';

import { attachWebSocketServer } from './server.js';

/**
 * These tests exist because of a window, not a line of code.
 *
 * `wss.on('connection')` awaits the Arcjet check, a network call measured at
 * 47-226ms in production. Anything registered after that await is absent for
 * the whole window, and two bugs lived there: a socket with no 'error'
 * listener (an uncaught exception, so any client could crash the server with
 * one oversized frame) and a socket whose only 'close' event landed on no
 * listener (so its subscription was never cleaned up).
 *
 * Neither is reproducible with the real dependency, because `wsArcjet` is null
 * without an ARCJET_KEY and the handler then runs start to finish
 * synchronously - there is no window at all. So the check is injected.
 */

// Stands in for the Arcjet round trip.
const slowAllow = (ms) => ({
  protect: async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { isDenied: () => false };
  },
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startServer(t, options = {}) {
  const server = http.createServer();
  // Long heartbeat so its sweep never interferes; the interval is unref'd, so
  // it will not hold the test process open either.
  const api = attachWebSocketServer(server, { heartbeatIntervalMs: 60_000, ...options });
  await new Promise((resolve) => server.listen(0, resolve));

  const sockets = new Set();
  t.after(async () => {
    for (const socket of sockets) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });

  const connect = () => {
    const socket = new WebSocket(`ws://localhost:${server.address().port}/ws`);
    // Client-side errors are expected in these tests (the server terminates
    // sockets); an unhandled 'error' here would fail the run for the wrong
    // reason.
    socket.on('error', () => {});
    sockets.add(socket);

    // One permanent listener feeding a queue, rather than a fresh once() per
    // read. The server sends 'welcome' and 'subscribed' back to back, so a
    // second once() attached after the first resolves misses the frame that
    // has already been emitted and waits forever.
    const received = [];
    const waiting = [];
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      const waiter = waiting.shift();
      if (waiter) waiter(message);
      else received.push(message);
    });

    const next = () =>
      new Promise((resolve) => {
        if (received.length) resolve(received.shift());
        else waiting.push(resolve);
      });

    return { socket, next };
  };

  return { api, connect };
}

const opened = (socket) => new Promise((resolve) => socket.on('open', resolve));

test('a protocol violation during the security check does not kill the server', async (t) => {
  const { connect } = await startServer(t, { arcjet: slowAllow(120) });

  const { socket: client } = connect();
  await opened(client);

  // Over the server's 1MB maxPayload, sent while the check is still in flight.
  // ws emits 'error' on the server-side socket for this; before the fix there
  // was no listener yet, and the emit became an uncaught exception.
  client.send(Buffer.alloc(1024 * 1024 + 1024));
  await new Promise((resolve) => client.on('close', resolve));

  // Surviving is the point, and "the process did not die" is worth asserting
  // properly: the server must still be serving.
  const { next: nextFromSurvivor } = connect();
  const welcome = await nextFromSurvivor();
  assert.equal(welcome.type, 'welcome', 'server should still accept connections');
});

test('a client that subscribes then drops mid-check leaves nothing behind', async (t) => {
  const { api, connect } = await startServer(t, { arcjet: slowAllow(150) });

  const { socket: client } = connect();
  await opened(client);

  // Queued, because the check has not resolved yet.
  client.send(JSON.stringify({ type: 'subscribe', matchId: 1 }));
  // Gone well inside the window. Its 'close' fires now; the queue drains later.
  await delay(20);
  client.terminate();

  // Let the check resolve and the drain either happen or be skipped.
  await delay(400);

  assert.deepEqual(
    api.stats().subscribersByMatch,
    {},
    'a CLOSED socket must not be left in matchSubscribers',
  );
  assert.equal(api.stats().clients, 0);
});

test('a subscription sent during the check is honoured once it resolves', async (t) => {
  const { api, connect } = await startServer(t, { arcjet: slowAllow(120) });

  const { socket: client, next } = connect();
  await opened(client);
  client.send(JSON.stringify({ type: 'subscribe', matchId: 7 }));

  assert.equal((await next()).type, 'welcome');
  assert.deepEqual(await next(), { type: 'subscribed', matchId: 7 });
  assert.deepEqual(api.stats().subscribersByMatch, { 7: 1 });

  // The guard added for the leak returns early on a non-OPEN socket. This is
  // the other side of it: a live socket must still get its queued messages.
  const frame = next();
  api.broadcastCommentaryCreated(7, { id: 42, matchId: 7 });
  assert.deepEqual(await frame, { type: 'commentaryCreated', data: { id: 42, matchId: 7 } });
});

test('closing a subscribed socket removes it from the subscriber map', async (t) => {
  const { api, connect } = await startServer(t, { arcjet: slowAllow(20) });

  const { socket: client, next } = connect();
  await opened(client);
  client.send(JSON.stringify({ type: 'subscribe', matchId: 3 }));
  await next(); // welcome
  await next(); // subscribed
  assert.deepEqual(api.stats().subscribersByMatch, { 3: 1 });

  client.close();
  await delay(150);

  assert.deepEqual(api.stats().subscribersByMatch, {}, 'the match entry should be dropped entirely');
  assert.equal(api.stats().clients, 0);
});

test('a denied connection is closed and never becomes a subscriber', async (t) => {
  const denyRateLimit = {
    protect: async () => ({
      isDenied: () => true,
      reason: { isRateLimit: () => true },
    }),
  };
  const { api, connect } = await startServer(t, { arcjet: denyRateLimit });

  const { socket: client } = connect();
  await opened(client);
  client.send(JSON.stringify({ type: 'subscribe', matchId: 5 }));

  const code = await new Promise((resolve) => client.on('close', resolve));
  assert.equal(code, 1013, 'rate-limited upgrades close with 1013 Try Again Later');

  await delay(100);
  assert.deepEqual(api.stats().subscribersByMatch, {});
});

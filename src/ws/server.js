import { WebSocket, WebSocketServer } from 'ws';
import { wsArcjet } from './arcjet.js';

// matchId -> the sockets watching that match. Commentary is high frequency and
// only interesting to viewers of one match, so it is delivered to subscribers
// rather than fanned out to everyone: cost scales with viewers-of-that-match
// instead of viewers x events.
const matchSubscribers = new Map();

// A subscription is server-side state a client can create for free, so both
// what it may subscribe to and how much are bounded.
const PG_INT4_MAX = 2_147_483_647;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 50;
// Bounded so a denied connection cannot buffer indefinitely before it closes.
const MAX_QUEUED_MESSAGES = 20;

const isValidMatchId = (value) =>
    Number.isInteger(value) && value > 0 && value <= PG_INT4_MAX;

function subscribe(socket, matchId) {
    if (!matchSubscribers.has(matchId)) {
        matchSubscribers.set(matchId, new Set());
    }

    matchSubscribers.get(matchId).add(socket);
}

function unsubscribe(socket, matchId) {
    const subscribers = matchSubscribers.get(matchId);
    if (!subscribers) return;
    subscribers.delete(socket);
    if (subscribers.size === 0) {
        matchSubscribers.delete(matchId);
    }
}

function cleanupSubscription(socket) {
    for (const matchId of socket.subscriptions) {
        unsubscribe(socket, matchId);
    }
}

function broadcastToMatchSubscribers(matchId, payload) {
    const subscribers = matchSubscribers.get(matchId);
    if (!subscribers || subscribers.size === 0) return;
    const message = JSON.stringify(payload);
    for (const client of subscribers) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

function sendJson(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
}

function broadcastToAll(wss, payload) {
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
        // `continue`, not `return` - one closed client must not stop the
        // broadcast to everyone after it.
        if (client.readyState !== WebSocket.OPEN) continue;
        client.send(message);
    }
}

function handleMessage(socket, data) {
    let message;
    try {
        message = JSON.parse(data.toString());
    } catch (error) {
        sendJson(socket, { type: 'error', error: 'Invalid JSON' });
        return;
    }

    if (message?.type === 'subscribe' && isValidMatchId(message.matchId)) {
        // Already subscribed is a no-op, so a client cannot spend its budget
        // by repeating the same id.
        if (!socket.subscriptions.has(message.matchId) &&
            socket.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) {
            sendJson(socket, { type: 'error', error: 'Subscription limit reached' });
            return;
        }

        subscribe(socket, message.matchId);
        socket.subscriptions.add(message.matchId);
        sendJson(socket, { type: 'subscribed', matchId: message.matchId });
        return;
    }

    if (message?.type === 'unsubscribe' && isValidMatchId(message.matchId)) {
        unsubscribe(socket, message.matchId);
        socket.subscriptions.delete(message.matchId);
        sendJson(socket, { type: 'unsubscribed', matchId: message.matchId });
        return;
    }

    sendJson(socket, { type: 'error', error: 'Unknown message type or missing matchId' });
}

// A TCP connection can die without either side sending a close frame - a
// sleeping laptop, dropped wifi, a NAT timeout. The socket then sits in
// wss.clients forever with readyState OPEN, so broadcasts are serialised and
// written to nothing and clients.size overreports. The fix is to ask.
const HEARTBEAT_INTERVAL_MS = 30_000;

export function attachWebSocketServer(server, { heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

    wss.on('connection', async (socket, req) => {
        // The Arcjet check below is a network call (measured 47-226ms). Node
        // drops a 'message' event with no listener, so registering the handler
        // after that await would silently discard anything a client sends on
        // connect - and subscribing immediately is the obvious thing to do.
        // Listen now, queue until the decision lands, then drain.
        const queued = [];
        let ready = false;

        socket.on('message', (data) => {
            if (ready) return handleMessage(socket, data);
            if (queued.length < MAX_QUEUED_MESSAGES) queued.push(data);
        });

        // Checked before any heartbeat state or welcome frame, so a rejected
        // connection is never treated as a live client.
        if (wsArcjet) {
            try {
                const decision = await wsArcjet.protect(req);

                if (decision.isDenied()) {
                    // 1013 Try Again Later vs 1008 Policy Violation: standard
                    // close codes, so a client can tell "retry later" apart
                    // from "never going to work".
                    const code = decision.reason.isRateLimit() ? 1013 : 1008;
                    const reason = decision.reason.isRateLimit() ? 'Rate limit exceeded' : 'Access denied';

                    socket.close(code, reason);
                    return;
                }
            } catch (e) {
                // Fails CLOSED, unlike the HTTP middleware which fails open:
                // an unvetted socket can persist for hours, so refuse rather
                // than admit a connection we could not evaluate.
                console.error('WS connection error', e);
                socket.close(1011, 'Server security error');
                return;
            }
        }

        socket.subscriptions = new Set();

        // Assume alive on connect; each pong re-arms it for the next sweep.
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });

        sendJson(socket, { type: 'welcome' });

        // Authorised: process anything that arrived while the check was in
        // flight, in the order it was sent.
        ready = true;
        for (const data of queued) handleMessage(socket, data);
        queued.length = 0;

        socket.on('error', (error) => {
            socket.terminate();
            console.error('WebSocket error', error);
        });
        socket.on('close', () => cleanupSubscription(socket));
    });

    // Two-phase sweep: a socket that failed to pong since the last tick has
    // had a full interval to answer, so it is gone - terminate() rather than
    // close(), because a half-open socket will never complete a handshake.
    const heartbeat = setInterval(() => {
        for (const socket of wss.clients) {
            if (socket.isAlive === false) {
                socket.terminate();
                continue;
            }
            socket.isAlive = false;
            socket.ping();
        }
    }, heartbeatIntervalMs);

    // Don't keep the process alive purely for this timer.
    heartbeat.unref();
    wss.on('close', () => clearInterval(heartbeat));

    function broadcastMatchCreated(match) {
        broadcastToAll(wss, { type: 'matchCreated', data: match });
    }

    function broadcastCommentaryCreated(matchId, commentary) {
        broadcastToMatchSubscribers(matchId, { type: 'commentaryCreated', data: commentary });
    }

    return {
        broadcastMatchCreated,
        broadcastCommentaryCreated
    };
}

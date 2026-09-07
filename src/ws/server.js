import { WebSocket, WebSocketServer } from 'ws';
import { wsArcjet } from './arcjet.js';

function sendJson(socket, payload) {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(payload));
}

function broadcastJson(wss, payload) {
    const message = JSON.stringify(payload);
    for (const client of wss.clients) {
        // `continue`, not `return` - one closed client must not stop the
        // broadcast to everyone after it.
        if (client.readyState !== WebSocket.OPEN) continue;
        client.send(message);
    }
}

// A TCP connection can die without either side sending a close frame - a
// sleeping laptop, dropped wifi, a NAT timeout. The socket then sits in
// wss.clients forever with readyState OPEN, so broadcasts are serialised and
// written to nothing and clients.size overreports. The fix is to ask.
const HEARTBEAT_INTERVAL_MS = 30_000;

export function attachWebSocketServer(server, { heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS } = {}) {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

    wss.on('connection', async (socket, req) => {
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

        // Assume alive on connect; each pong re-arms it for the next sweep.
        socket.isAlive = true;
        socket.on('pong', () => { socket.isAlive = true; });

        sendJson(socket, { type: 'welcome' });
        socket.on('error', console.error);
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
        broadcastJson(wss, { type: 'matchCreated', data: match });
    }

    return {
        broadcastMatchCreated
    };
}

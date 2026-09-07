import { WebSocket, WebSocketServer } from 'ws';

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

export function attachWebSocketServer(server) {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 1024 * 1024 });

    wss.on('connection', (socket) => {
        sendJson(socket, { type: 'welcome' });
        socket.on('error', console.error);
    });

    function broadcastMatchCreated(match) {
        broadcastJson(wss, { type: 'matchCreated', data: match });
    }

    return {
        broadcastMatchCreated
    };
}

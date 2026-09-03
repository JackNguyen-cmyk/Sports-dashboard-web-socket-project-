import { WebSocketServer,WebSocket } from "ws";   

const wss = new WebSocketServer({ port: 8080 }); // Zombie http 

wss.on("connection", (socket,request) => {
  const ip = request.socket.remoteAddress;
  socket.on("message", (rawData) => {
    const message = rawData.toString();
    console.log({rawData});

    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(`Server broadcast: ${message}`);
      }
    });
  });

  socket.on("error", (err)=>{
    console.log(`Error: ${err.message}: ${ip} `);
  })

  socket.on('close',()=>{
    console.log(`Client disconnected: ${ip}`);
  })
});

console.log("WebSocket server is running on ws://localhost:8080");
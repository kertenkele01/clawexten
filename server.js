const WebSocket = require('ws');
const http = require('http');
const express = require('express');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

let extensionClient = null;
let controllerClient = null;

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.get('/', (req, res) => {
  res.json({
    status: 'TJK Relay Aktif',
    extension: extensionClient ? 'Bagli' : 'Bagli degil',
    controller: controllerClient ? 'Bagli' : 'Bagli degil',
    connections: wss.clients.size,
    time: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

wss.on('connection', (ws, req) => {
  console.log('Yeni baglanti:', new Date().toISOString());
  
  ws.once('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'register') {
        if (data.role === 'extension') {
          extensionClient = ws;
          console.log('Extension baglandi');
          ws.send(JSON.stringify({ type: 'status', message: 'Extension kaydedildi' }));
          
          if (controllerClient) {
            controllerClient.send(JSON.stringify({ type: 'info', message: 'Extension baglandi' }));
          }
        } else if (data.role === 'controller') {
          controllerClient = ws;
          console.log('Controller baglandi');
          ws.send(JSON.stringify({ type: 'status', message: 'Controller kaydedildi' }));
        }
        
        ws.on('message', (msg) => {
          handleMessage(ws, msg);
        });
      }
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Gecersiz kayit' }));
    }
  });
  
  ws.on('close', () => {
    if (ws === extensionClient) {
      console.log('Extension koptu');
      extensionClient = null;
    }
    if (ws === controllerClient) {
      console.log('Controller koptu');
      controllerClient = null;
    }
  });
});

function handleMessage(from, message) {
  try {
    if (from === extensionClient && controllerClient) {
      controllerClient.send(message);
    } else if (from === controllerClient && extensionClient) {
      extensionClient.send(message);
    }
  } catch (e) {
    console.error('Mesaj hatasi:', e);
  }
}

server.listen(PORT, () => {
  console.log('TJK Relay calisiyor! Port:', PORT);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

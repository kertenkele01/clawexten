const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 10000;
const VALID_TOKENS = new Set();

const clients = new Map();
const bots = new Map();

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i === 3 || i === 7) token += '-';
  }
  return token;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      connections: clients.size,
      bots: bots.size
    }));
    return;
  }

  if (req.url === '/generate-token' && req.method === 'POST') {
    const token = generateToken();
    VALID_TOKENS.add(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      token: token,
      message: 'Token created. Share this with your extension.'
    }));
    return;
  }

  if (req.url === '/tokens') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      valid_tokens: VALID_TOKENS.size,
      active_connections: clients.size,
      active_bots: bots.size
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: 'Corby Bridge Server',
    version: '2.0.0',
    status: 'running',
    endpoints: ['/health', '/generate-token', '/tokens']
  }));
});

const wss = new WebSocket.Server({ server });wss.on('connection', (ws, req) => {
  console.log('[Server] New connection from', req.socket.remoteAddress);
  
  let clientInfo = null;
  let isAuthenticated = false;
  
  const authTimeout = setTimeout(() => {
    if (!isAuthenticated) {
      ws.close(1008, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'auth') {
        clearTimeout(authTimeout);
        const token = message.token;
        
        if (!token || !VALID_TOKENS.has(token)) {
          ws.send(JSON.stringify({
            type: 'auth_error',
            message: 'Invalid or expired token'
          }));
          ws.close(1008, 'Invalid token');
          return;
        }

        isAuthenticated = true;
        const clientType = message.client || 'unknown';

        if (clientType.includes('bot') || clientType === 'clawbot') {
          bots.set(token, { ws, lastPing: Date.now() });
          clientInfo = { token, type: 'bot' };
          ws.send(JSON.stringify({
            type: 'auth_success',
            message: 'Bot authenticated'
          }));
        } else {
          clients.set(token, { ws, type: 'extension', lastPing: Date.now() });
          clientInfo = { token, type: 'extension' };
          ws.send(JSON.stringify({
            type: 'auth_success',
            message: 'Extension authenticated'
          }));
        }
        return;
      }

      if (!isAuthenticated) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Authentication required' }));
        return;
      }

      if (message.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
        if (clientInfo?.token) {
          const map = clientInfo.type === 'bot' ? bots : clients;
          if (map.has(clientInfo.token)) {
            map.get(clientInfo.token).lastPing = Date.now();
          }
        }
        return;
      }

      // Forward messages between bot and extension with same token
      if (clientInfo?.type === 'bot') {
        const ext = clients.get(clientInfo.token);
        if (ext?.ws?.readyState === WebSocket.OPEN) {
          ext.ws.send(JSON.stringify(message));
        }
      } else if (clientInfo?.type === 'extension') {
        const bot = bots.get(clientInfo.token);
        if (bot?.ws?.readyState === WebSocket.OPEN) {
          bot.ws.send(JSON.stringify(message));
        }
      }

    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (clientInfo?.token) {
      if (clientInfo.type === 'bot') bots.delete(clientInfo.token);
      else clients.delete(clientInfo.token);
    }
  });
});

// Cleanup dead connections
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of clients) {
    if (now - data.lastPing > 60000) {
      data.ws.close();
      clients.delete(token);
    }
  }
  for (const [token, data] of bots) {
    if (now - data.lastPing > 60000) {
      data.ws.close();
      bots.delete(token);
    }
  }
}, 30000);

server.listen(PORT, () => {
  console.log('Corby Bridge Server v2.0.0 on port', PORT);
  console.log('POST /generate-token to create tokens');
});

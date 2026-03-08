const WebSocket = require('ws');
const http = require('http');

// Render ortamı için port ayarı
const PORT = process.env.PORT || 10000;

// Sistemde üretilen ve geçerli olan token'ları tutan küme
const VALID_TOKENS = new Set();

// Bağlı istemcileri ayırmak için haritalar
const clients = new Map(); // Tarayıcı Eklentileri (Corby Bridge)
const bots = new Map();    // Sunucu Botları (OpenClaw)

// Rastgele, güvenli formatta token üreten fonksiyon
function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
    if (i === 3 || i === 7) token += '-';
  }
  return token;
}

// HTTP Sunucusu (Token üretimi ve sağlık durumu için)
const server = http.createServer((req, res) => {
  // Eklentinin fetch() isteği yapabilmesi için CORS ayarları
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Tarayıcıların ön uçuş (preflight) isteklerini yanıtla
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // Render'ın sunucunun ayakta olup olmadığını kontrol edeceği uç nokta
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      connections: clients.size,
      bots: bots.size
    }));
    return;
  }

  // Eklentiden (options.js) gelen yeni token taleplerini karşıla
  if (req.url === '/generate-token' && req.method === 'POST') {
    const token = generateToken();
    VALID_TOKENS.add(token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      token: token,
      message: 'Token created. Share this with your bot and extension.'
    }));
    return;
  }

  // Aktif durumları görmek için (Yönetici paneli vs. için kullanılabilir)
  if (req.url === '/tokens') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      valid_tokens: VALID_TOKENS.size,
      active_extensions: clients.size,
      active_bots: bots.size
    }));
    return;
  }

  // Ana sayfa
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    name: 'Corby Bridge Server',
    version: '2.0.0',
    status: 'running',
    endpoints: ['/health', '/generate-token (POST)', '/tokens']
  }));
});

// WebSocket Sunucusu (Gerçek zamanlı iletişim için)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
  console.log('[Server] Yeni bağlantı:', req.socket.remoteAddress);
  
  let clientInfo = null;
  let isAuthenticated = false;
  
  // 10 saniye içinde token göndermeyenleri sistemden at
  const authTimeout = setTimeout(() => {
    if (!isAuthenticated) {
      ws.close(1008, 'Authentication timeout');
    }
  }, 10000);

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());

      // 1. ADIM: Doğrulama (Authentication)
      if (message.type === 'auth') {
        clearTimeout(authTimeout);
        const token = message.token;
        
        // Token sistemde kayıtlı değilse reddet
        if (!token || !VALID_TOKENS.has(token)) {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Invalid or expired token' }));
          ws.close(1008, 'Invalid token');
          return;
        }

        isAuthenticated = true;
        const clientType = message.client || 'unknown';

        // Gelen bağlantı bir bot mu yoksa eklenti mi?
        if (clientType.includes('bot') || clientType === 'clawbot') {
          bots.set(token, { ws, lastPing: Date.now() });
          clientInfo = { token, type: 'bot' };
          ws.send(JSON.stringify({ type: 'auth_success', message: 'Bot authenticated' }));
          console.log(`[Server] Bot bağlandı. Token: ${token}`);
        } else {
          clients.set(token, { ws, type: 'extension', lastPing: Date.now() });
          clientInfo = { token, type: 'extension' };
          ws.send(JSON.stringify({ type: 'auth_success', message: 'Extension authenticated' }));
          console.log(`[Server] Eklenti bağlandı. Token: ${token}`);
        }
        return;
      }

      // Doğrulanmamış istemciler işlem yapamaz
      if (!isAuthenticated) {
        ws.send(JSON.stringify({ type: 'auth_error', message: 'Authentication required' }));
        return;
      }

      // 2. ADIM: Canlılık Kontrolü (Ping-Pong)
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

      // 3. ADIM: Mesaj Yönlendirme (Köprü Görevi)
      if (clientInfo?.type === 'bot') {
        // Bot mesaj gönderdiyse, eklentiye ilet
        const ext = clients.get(clientInfo.token);
        if (ext?.ws?.readyState === WebSocket.OPEN) {
          ext.ws.send(JSON.stringify(message));
        }
      } else if (clientInfo?.type === 'extension') {
        // Eklenti mesaj (örn: veri veya sonuç) gönderdiyse, bota ilet
        const bot = bots.get(clientInfo.token);
        if (bot?.ws?.readyState === WebSocket.OPEN) {
          bot.ws.send(JSON.stringify(message));
        }
      }

    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
    }
  });

  // Bağlantı koptuğunda haritalardan temizle
  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (clientInfo?.token) {
      if (clientInfo.type === 'bot') {
        bots.delete(clientInfo.token);
        console.log(`[Server] Bot ayrıldı. Token: ${clientInfo.token}`);
      } else {
        clients.delete(clientInfo.token);
        console.log(`[Server] Eklenti ayrıldı. Token: ${clientInfo.token}`);
      }
    }
  });
});



// Ölü bağlantıları temizleme rutini (Memory Leak engellemek için)
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of clients) {
    if (now - data.lastPing > 60000) { // 60 saniye boyunca ping atmamışsa
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
}, 30000); // Her 30 saniyede bir kontrol et

// Sunucuyu Başlat
server.listen(PORT, () => {
  console.log(`Corby Bridge Server v2.0.0 is running on port ${PORT}`);
  console.log('HTTP/WebSocket Dinleniyor...');
});

const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 10000;
const VALID_TOKENS = new Set();

// 🚀 KALICI TOKENLARI YÜKLE
if (process.env.MASTER_TOKENS) {
    process.env.MASTER_TOKENS.split(',').forEach(t => VALID_TOKENS.add(t.trim()));
    console.log('✅ Kalıcı tokenlar yüklendi:', process.env.MASTER_TOKENS);
}

const clients = new Map();
const bots = new Map();

const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Sağlık kontrolü ve bilgi
    if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name: 'Corby Bridge Persistent', status: 'running', active_ext: clients.size }));
        return;
    }

    // Manuel token üretme (Yine çalışır ama geçicidir)
    if (req.url === '/generate-token' && req.method === 'POST') {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let token = '';
        for (let i = 0; i < 12; i++) {
            token += chars.charAt(Math.floor(Math.random() * chars.length));
            if (i === 3 || i === 7) token += '-';
        }
        VALID_TOKENS.add(token);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: token, type: 'temporary' }));
        return;
    }
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    let clientInfo = null;
    let authenticated = false;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            if (msg.type === 'auth') {
                if (VALID_TOKENS.has(msg.token)) {
                    authenticated = true;
                    clientInfo = { token: msg.token, type: msg.client.includes('bot') ? 'bot' : 'ext' };
                    
                    if (clientInfo.type === 'bot') {
                        bots.set(msg.token, ws);
                        const ext = clients.get(msg.token);
                        if (ext) ws.send(JSON.stringify({ type: 'extension_online' }));
                    } else {
                        clients.set(msg.token, ws);
                        const bot = bots.get(msg.token);
                        if (bot) bot.send(JSON.stringify({ type: 'extension_online' }));
                    }
                    ws.send(JSON.stringify({ type: 'auth_success' }));
                } else {
                    ws.send(JSON.stringify({ type: 'auth_error', message: 'Geçersiz Token' }));
                    ws.close();
                }
                return;
            }

            if (!authenticated) return;

            // Mesajları eşleşen tokenlar arasında aktar
            if (clientInfo.type === 'bot') {
                const target = clients.get(clientInfo.token);
                if (target) target.send(JSON.stringify(msg));
            } else {
                const target = bots.get(clientInfo.token);
                if (target) target.send(JSON.stringify(msg));
            }
        } catch (e) {}
    });

    ws.on('close', () => {
        if (clientInfo) {
            if (clientInfo.type === 'bot') bots.delete(clientInfo.token);
            else clients.delete(clientInfo.token);
        }
    });
});

server.listen(PORT, () => console.log('Server is running...'));

const http = require('http');

const PORT = 3000;
let rooms = [];           // each room: { id, title, isPrivate, currentPlayers, maxPlayers, passcode, hostPeerId, lastSeen }
let signals = [];         // each signal: { id, roomId, from, to, type, payload, createdAt }

// Helper to send JSON response with CORS headers
const sendJson = (res, status, data) => {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-passcode'
    });
    res.end(JSON.stringify(data));
};

// Helper to read JSON body
const readJsonBody = (req, onBody, onError) => {
    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
        try {
            onBody(body ? JSON.parse(body) : {});
        } catch (error) {
            onError(error);
        }
    });
};

// Extract original room id from the full signal roomId (e.g., "glossary-game-abc123" -> "abc123")
const extractOriginalRoomId = (fullRoomId) => {
    const prefix = 'glossary-game-';
    if (fullRoomId.startsWith(prefix)) {
        return fullRoomId.slice(prefix.length);
    }
    return fullRoomId;
};

// Find room by its original id OR full signal roomId
const findRoomByAnyId = (searchId) => {
    const originalId = extractOriginalRoomId(searchId);
    return rooms.find(r => r.id === originalId || `glossary-game-${r.id}` === searchId);
};

// Verify passcode for a room (if room is private)
const verifyPasscode = (req, room) => {
    if (!room) return false;
    // If room is not private, any passcode (or none) is accepted? Actually game uses passcode for all rooms.
    // The client always sends x-passcode. We'll require exact match for all rooms.
    const clientPasscode = req.headers['x-passcode'];
    return clientPasscode && clientPasscode === room.passcode;
};

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Handle CORS preflight (OPTIONS)
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, x-passcode',
            'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
    }

    // ----- Rooms API -----

    // GET /rooms - list public rooms (no passcode required)
    if (req.method === 'GET' && url.pathname === '/rooms') {
        const safeRooms = rooms.map(r => ({
            id: r.id,
            title: r.title,
            isPrivate: r.isPrivate,
            currentPlayers: r.currentPlayers,
            maxPlayers: r.maxPlayers,
            passcode: r.isPrivate ? null : r.passcode   // hide passcode for private rooms
        }));
        sendJson(res, 200, safeRooms);
        return;
    }

    // POST /rooms - create or update room (requires passcode in body)
    if (req.method === 'POST' && url.pathname === '/rooms') {
        readJsonBody(req, (roomData) => {
            if (!roomData.id || !roomData.passcode) {
                sendJson(res, 400, { success: false, error: 'Missing id or passcode' });
                return;
            }

            const existingIndex = rooms.findIndex(r => r.id === roomData.id);
            const room = {
                id: roomData.id,
                title: roomData.title || 'Untitled Room',
                isPrivate: roomData.isPrivate === true,
                currentPlayers: roomData.currentPlayers || 1,
                maxPlayers: roomData.maxPlayers || 3,
                passcode: roomData.passcode,
                hostPeerId: roomData.hostPeerId || '',
                lastSeen: Date.now()
            };

            if (existingIndex >= 0) {
                // Update: only allow if passcode matches (or if no existing passcode? For safety require match)
                const existingRoom = rooms[existingIndex];
                const clientPasscode = roomData.passcode;
                if (existingRoom.passcode !== clientPasscode) {
                    sendJson(res, 403, { success: false, error: 'Invalid passcode for room update' });
                    return;
                }
                rooms[existingIndex] = room;
            } else {
                rooms.push(room);
            }
            sendJson(res, 200, { success: true });
        }, () => sendJson(res, 400, { success: false, error: 'Invalid JSON body' }));
        return;
    }

    // DELETE /rooms/:id - delete room (requires passcode in x-passcode header)
    if (req.method === 'DELETE' && url.pathname.startsWith('/rooms/')) {
        const id = decodeURIComponent(url.pathname.split('/')[2] || '');
        const room = rooms.find(r => r.id === id);
        if (!room) {
            sendJson(res, 404, { success: false, error: 'Room not found' });
            return;
        }
        if (!verifyPasscode(req, room)) {
            sendJson(res, 403, { success: false, error: 'Invalid passcode' });
            return;
        }
        rooms = rooms.filter(r => r.id !== id);
        // Also clear signals for this room (both forms)
        const fullRoomId = `glossary-game-${id.toLowerCase()}`;
        signals = signals.filter(s => s.roomId !== fullRoomId && s.roomId !== id);
        sendJson(res, 200, { success: true });
        return;
    }

    // ----- Signalling API (all require passcode verification) -----

    // GET /signals/:roomId?peerId=xxx
    if (req.method === 'GET' && url.pathname.startsWith('/signals/')) {
        const fullRoomId = decodeURIComponent(url.pathname.split('/')[2] || '');
        const peerId = url.searchParams.get('peerId');
        if (!fullRoomId || !peerId) {
            sendJson(res, 400, { success: false, error: 'Missing roomId or peerId' });
            return;
        }

        const room = findRoomByAnyId(fullRoomId);
        if (!room) {
            sendJson(res, 404, { success: false, error: 'Room not found' });
            return;
        }
        if (!verifyPasscode(req, room)) {
            sendJson(res, 403, { success: false, error: 'Invalid passcode' });
            return;
        }

        const visibleSignals = signals.filter(signal => (
            signal.roomId === fullRoomId &&
            signal.from !== peerId &&
            (!signal.to || signal.to === peerId)
        ));
        sendJson(res, 200, visibleSignals);
        return;
    }

    // POST /signals/:roomId
    if (req.method === 'POST' && url.pathname.startsWith('/signals/')) {
        const fullRoomId = decodeURIComponent(url.pathname.split('/')[2] || '');
        if (!fullRoomId) {
            sendJson(res, 400, { success: false, error: 'Missing roomId' });
            return;
        }

        const room = findRoomByAnyId(fullRoomId);
        if (!room) {
            sendJson(res, 404, { success: false, error: 'Room not found' });
            return;
        }
        if (!verifyPasscode(req, room)) {
            sendJson(res, 403, { success: false, error: 'Invalid passcode' });
            return;
        }

        readJsonBody(req, (signal) => {
            if (!signal.from || !signal.type || !signal.payload) {
                sendJson(res, 400, { success: false, error: 'Invalid signal' });
                return;
            }

            signals.push({
                id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
                roomId: fullRoomId,
                from: signal.from,
                to: signal.to || null,
                type: signal.type,
                payload: signal.payload,
                createdAt: Date.now()
            });
            sendJson(res, 200, { success: true });
        }, () => sendJson(res, 400, { success: false, error: 'Invalid JSON body' }));
        return;
    }

    // DELETE /signals/:roomId/:peerId
    if (req.method === 'DELETE' && url.pathname.startsWith('/signals/')) {
        const parts = url.pathname.split('/');
        const fullRoomId = decodeURIComponent(parts[2] || '');
        const peerId = decodeURIComponent(parts[3] || '');

        if (!fullRoomId) {
            sendJson(res, 400, { success: false, error: 'Missing roomId' });
            return;
        }

        const room = findRoomByAnyId(fullRoomId);
        if (!room) {
            sendJson(res, 404, { success: false, error: 'Room not found' });
            return;
        }
        if (!verifyPasscode(req, room)) {
            sendJson(res, 403, { success: false, error: 'Invalid passcode' });
            return;
        }

        signals = signals.filter(signal => (
            signal.roomId !== fullRoomId ||
            (peerId && signal.from !== peerId && signal.to !== peerId)
        ));
        sendJson(res, 200, { success: true });
        return;
    }

    // 404 for unknown routes
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Lobby Server with passcode verification running at http://0.0.0.0:${PORT}`);
});

// Cleanup stale rooms and signals every 5 seconds
setInterval(() => {
    const now = Date.now();
    const beforeCount = rooms.length;
    rooms = rooms.filter(r => now - r.lastSeen < 10000);
    signals = signals.filter(signal => now - signal.createdAt < 30000);
    if (rooms.length < beforeCount) {
        console.log(`Cleaned up ${beforeCount - rooms.length} stale rooms.`);
    }
}, 5000);

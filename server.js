require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    {
      urls: `turn:${process.env.TURN_URL || 'relay.metered.ca:80'}`,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || '',
    },
  ],
};

const waitingQueue = [];
const activeRooms = new Map();

app.get('/ice-servers', (req, res) => res.json(ICE_SERVERS));

function findExistingRoom(socketId) {
  for (const [roomId, members] of activeRooms) {
    if (members.includes(socketId)) return roomId;
  }
  return null;
}

function tryMatch(socket) {
  if (waitingQueue.length === 0) {
    waitingQueue.push(socket.id);
    socket.emit('waiting');
    return;
  }

  const peerId = waitingQueue.shift();
  if (peerId === socket.id) {
    waitingQueue.push(socket.id);
    socket.emit('waiting');
    return;
  }

  const peer = io.sockets.sockets.get(peerId);
  if (!peer) {
    tryMatch(socket);
    return;
  }

  const roomId = uuidv4().slice(0, 8);
  socket.join(roomId);
  peer.join(roomId);
  activeRooms.set(roomId, [socket.id, peerId]);

  const initiator = socket.id;
  const receiver = peerId;
  socket.emit('matched', { roomId, initiator: true, peerId: receiver });
  peer.emit('matched', { roomId, initiator: false, peerId: initiator });
}

io.on('connection', (socket) => {
  console.log(`[connect] ${socket.id}`);

  socket.on('find-match', () => tryMatch(socket));

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('chat-message', ({ to, text }) => {
    io.to(to).emit('chat-message', { from: socket.id, text });
  });

  socket.on('typing', ({ to }) => {
    io.to(to).emit('typing', { from: socket.id });
  });

  socket.on('stop-typing', ({ to }) => {
    io.to(to).emit('stop-typing', { from: socket.id });
  });

  socket.on('next', () => {
    const roomId = findExistingRoom(socket.id);
    if (roomId) {
      const members = activeRooms.get(roomId) || [];
      members.forEach((id) => {
        if (id !== socket.id) {
          io.to(id).emit('peer-disconnected', { reason: 'next' });
        }
        const s = io.sockets.sockets.get(id);
        if (s) s.leave(roomId);
      });
      activeRooms.delete(roomId);
    }
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    tryMatch(socket);
  });

  socket.on('stop', () => {
    const roomId = findExistingRoom(socket.id);
    if (roomId) {
      const members = activeRooms.get(roomId) || [];
      members.forEach((id) => {
        if (id !== socket.id) {
          io.to(id).emit('peer-disconnected', { reason: 'stopped' });
        }
        const s = io.sockets.sockets.get(id);
        if (s) s.leave(roomId);
      });
      activeRooms.delete(roomId);
    }
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    socket.emit('stopped');
  });

  socket.on('report', ({ reason }) => {
    const report = { reporter: socket.id, reason, time: new Date().toISOString() };
    console.log('[report]', JSON.stringify(report));
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    const roomId = findExistingRoom(socket.id);
    if (roomId) {
      const members = activeRooms.get(roomId) || [];
      members.forEach((id) => {
        if (id !== socket.id) {
          io.to(id).emit('peer-disconnected', { reason: 'disconnected' });
        }
        const s = io.sockets.sockets.get(id);
        if (s) s.leave(roomId);
      });
      activeRooms.delete(roomId);
    }
    const idx = waitingQueue.indexOf(socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
  });
});

server.listen(PORT, () => {
  console.log(`StrangerLink server running on http://localhost:${PORT}`);
});

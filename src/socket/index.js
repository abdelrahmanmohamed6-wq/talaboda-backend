const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
let io;

async function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' }
  });

  // Redis adapter — enables multi-instance scaling
  if (process.env.REDIS_URL) {
    try {
      const { createAdapter } = require('@socket.io/redis-adapter');
      const { createClient } = require('ioredis');
      const pub = createClient(process.env.REDIS_URL);
      const sub = pub.duplicate();
      await Promise.all([pub.connect(), sub.connect()]);
      io.adapter(createAdapter(pub, sub));
      console.log('[socket] Redis adapter connected');
    } catch (e) {
      console.warn('[socket] Redis adapter failed, using in-memory:', e.message);
    }
  }

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('No token'));
    try {
      socket.user = jwt.verify(token, process.env.JWT_SECRET);
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role, branchId, chainId } = socket.user;

    if (role === 'DRIVER') {
      socket.join(`driver:${id}`);
      socket.join(`branch:${branchId}`);
    }

    if (role === 'BRANCH_MANAGER') {
      socket.join(`branch:${branchId}`);
    }

    if (role === 'SUPER_ADMIN') {
      socket.join('admin');
    }

    if (role === 'CHAIN_OWNER' && chainId) {
      socket.join(`chain:${chainId}`);
    }

    socket.on('driver:location', ({ lat, lng }) => {
      if (role !== 'DRIVER') return;
      const payload = { driverId: id, lat, lng, timestamp: new Date() };
      io.to(`branch:${branchId}`).emit('driver:location', payload);
      if (chainId) io.to(`chain:${chainId}`).emit('driver:location', payload);
      io.to('admin').emit('driver:location', payload);
      prisma.driverLocation.create({ data: { driverId: id, lat, lng } }).catch(() => {});
    });

    socket.on('disconnect', () => {});
  });

  return io;
}

function getIO() {
  return io;
}

module.exports = { initSocket, getIO };

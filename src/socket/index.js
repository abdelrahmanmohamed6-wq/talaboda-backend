const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: { origin: '*' }
  });

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
    const { id, role, branchId } = socket.user;

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

    socket.on('driver:location', ({ lat, lng }) => {
      if (role !== 'DRIVER') return;
      const payload = { driverId: id, lat, lng, timestamp: new Date() };
      io.to(`branch:${branchId}`).emit('driver:location', payload);
      io.to('admin').emit('driver:location', payload);
      saveLocation(id, lat, lng);
    });

    socket.on('disconnect', () => {});
  });

  return io;
}

async function saveLocation(driverId, lat, lng) {
  try {
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    await prisma.driverLocation.create({ data: { driverId, lat, lng } });
    await prisma.$disconnect();
  } catch {}
}

function getIO() {
  return io;
}

module.exports = { initSocket, getIO };

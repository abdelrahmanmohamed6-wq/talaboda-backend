const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { getIO } = require('../socket');
const talabat = require('../services/talabat');

const prisma = new PrismaClient();

// Load chain credentials for a given branchId
async function chainCreds(branchId) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    include: { chain: { select: { talabatClientId: true, talabatClientSecret: true } } }
  });
  return [branch?.chain?.talabatClientId, branch?.chain?.talabatClientSecret];
}

router.get('/', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const where = req.user.role === 'BRANCH_MANAGER' ? { branchId: req.user.branchId } : {};
  const orders = await prisma.order.findMany({
    where,
    include: { driver: { select: { id: true, name: true, phone: true, role: true, isActive: true } }, branch: true },
    orderBy: { createdAt: 'desc' },
    take: 100
  });
  res.json(orders);
});

router.get('/my', auth(['DRIVER']), async (req, res) => {
  const orders = await prisma.order.findMany({
    where: { driverId: req.user.id, status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } },
    include: { branch: true },
    orderBy: { assignedAt: 'desc' }
  });
  res.json(orders);
});

router.patch('/:id/pickup', auth(['DRIVER']), async (req, res) => {
  const order = await prisma.order.update({
    where: { id: req.params.id, driverId: req.user.id },
    data: { status: 'PICKED_UP', pickedUpAt: new Date() }
  });
  getIO().to(`branch:${order.branchId}`).emit('order:updated', order);
  getIO().to('admin').emit('order:updated', order);
  const creds = await chainCreds(order.branchId);
  await talabat.updateOrderStatus(order.talabatOrderId, 'PICKED_UP', ...creds);
  res.json(order);
});

router.patch('/:id/transit', auth(['DRIVER']), async (req, res) => {
  const order = await prisma.order.update({
    where: { id: req.params.id, driverId: req.user.id },
    data: { status: 'IN_TRANSIT' }
  });
  getIO().to(`branch:${order.branchId}`).emit('order:updated', order);
  getIO().to('admin').emit('order:updated', order);
  const creds = await chainCreds(order.branchId);
  await talabat.updateOrderStatus(order.talabatOrderId, 'IN_TRANSIT', ...creds);
  res.json(order);
});

router.patch('/:id/deliver', auth(['DRIVER']), async (req, res) => {
  const { paymentType } = req.body;
  const order = await prisma.order.update({
    where: { id: req.params.id, driverId: req.user.id },
    data: { status: 'DELIVERED', deliveredAt: new Date(), paymentType }
  });

  const shift = await prisma.shift.findFirst({ where: { driverId: req.user.id, status: 'ACTIVE' } });
  if (shift) {
    const update = paymentType === 'CASH'
      ? { totalCash: { increment: order.amount } }
      : { totalCard: { increment: order.amount } };
    await prisma.shift.update({ where: { id: shift.id }, data: update });
  }

  getIO().to(`branch:${order.branchId}`).emit('order:updated', order);
  getIO().to('admin').emit('order:updated', order);
  const creds = await chainCreds(order.branchId);
  await talabat.updateOrderStatus(order.talabatOrderId, 'DELIVERED', ...creds);
  res.json(order);
});

router.patch('/:id/transfer', auth(['BRANCH_MANAGER']), async (req, res) => {
  const { newDriverId } = req.body;
  const order = await prisma.order.update({
    where: { id: req.params.id, branchId: req.user.branchId },
    data: { driverId: newDriverId, assignedAt: new Date() }
  });
  getIO().to(`branch:${order.branchId}`).emit('order:updated', order);
  getIO().to(`driver:${newDriverId}`).emit('order:new', order);
  res.json(order);
});

router.patch('/:id/reassign', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const { driverId } = req.body;
  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: { driverId, assignedAt: new Date(), status: 'ASSIGNED' }
  });
  getIO().to(`branch:${order.branchId}`).emit('order:updated', order);
  getIO().to(`driver:${driverId}`).emit('order:new', order);
  res.json(order);
});

module.exports = router;

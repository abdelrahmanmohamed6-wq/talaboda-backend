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

// Import a past Talabat order by its order_id (UUID from webhook / external_order_id numeric)
router.post('/import/:talabatOrderId', auth(['SUPER_ADMIN']), async (req, res) => {
  const { talabatOrderId } = req.params;
  const { branchId } = req.body;

  // Find branch — either provided or first match
  const branch = branchId
    ? await prisma.branch.findUnique({ where: { id: branchId }, include: { chain: true } })
    : await prisma.branch.findFirst({ include: { chain: true } });

  if (!branch) return res.status(404).json({ error: 'Branch not found' });

  // Don't duplicate
  const existing = await prisma.order.findUnique({ where: { talabatOrderId: String(talabatOrderId) } });
  if (existing) return res.json({ message: 'Already imported', order: existing });

  try {
    const details = await talabat.getOrderDetails(
      talabatOrderId,
      branch.chain?.talabatClientId,
      branch.chain?.talabatClientSecret
    );
    if (!details) return res.status(404).json({ error: 'Order not found in Talabat API' });

    const delivAddr = details.delivery_address || {};
    const items = details.products || details.items || [];

    const order = await prisma.order.create({
      data: {
        talabatOrderId: String(talabatOrderId),
        status: 'PENDING',
        talabatStatus: details.status || 'IMPORTED',
        branchId: branch.id,
        customerName: details.customer?.name || details.customer?.first_name || 'عميل',
        customerPhone: details.customer?.phone || details.customer?.phone_number || '',
        customerAddress: delivAddr.description || [delivAddr.street, delivAddr.suburb, delivAddr.city].filter(Boolean).join(', ') || '',
        customerLat: delivAddr.latitude || null,
        customerLng: delivAddr.longitude || null,
        amount: details.total_value ?? details.price?.total ?? 0,
        paymentType: (details.payment_type === 'online' || details.payment_type === 'CARD') ? 'CARD' : 'CASH',
        items: items.length > 0 ? items : undefined,
      }
    });

    getIO()?.to('admin').emit('order:new', order);
    getIO()?.to(`branch:${branch.id}`).emit('order:new', order);
    res.json({ message: 'Imported successfully', order });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

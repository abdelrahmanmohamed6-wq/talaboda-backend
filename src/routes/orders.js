const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const { getIO } = require('../socket');
const talabat = require('../services/talabat');
const { notifyClient } = require('../services/clientWebhook');

const prisma = new PrismaClient();

// Load chain credentials + chainId for a given branchId
async function chainCreds(branchId) {
  const branch = await prisma.branch.findUnique({
    where: { id: branchId },
    include: { chain: { select: { talabatClientId: true, talabatClientSecret: true, talabatChainId: true } } }
  });
  return [branch?.chain?.talabatClientId, branch?.chain?.talabatClientSecret, branch?.chain?.talabatChainId];
}

router.get('/', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const where =
    req.user.role === 'BRANCH_MANAGER' ? { branchId: req.user.branchId } :
    req.user.role === 'CHAIN_OWNER' ? { branch: { chainId: req.user.chainId } } :
    {};
  const { date } = req.query; // 'YYYY-MM-DD' — filter by createdAt date
  if (date) {
    const start = new Date(date);
    const end = new Date(date);
    end.setDate(end.getDate() + 1);
    where.createdAt = { gte: start, lt: end };
  }
  const orders = await prisma.order.findMany({
    where,
    include: { driver: { select: { id: true, name: true, phone: true, role: true, isActive: true } }, branch: true },
    orderBy: { createdAt: 'desc' },
    take: 500
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
  notifyClient(order.id).catch(() => {});
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
  notifyClient(order.id).catch(() => {});
  res.json(order);
});

router.patch('/:id/deliver', auth(['DRIVER']), async (req, res) => {
  const { paymentType, proofPhoto } = req.body;
  const data = { status: 'DELIVERED', deliveredAt: new Date(), paymentType };
  if (proofPhoto) data.proofPhoto = proofPhoto;
  const order = await prisma.order.update({
    where: { id: req.params.id, driverId: req.user.id },
    data
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
  notifyClient(order.id).catch(() => {});
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
      branch.chain?.talabatClientSecret,
      branch.chain?.talabatChainId
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

router.patch('/:id/reassign', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const { driverId } = req.body;
  const order = await prisma.order.update({
    where: { id: req.params.id },
    data: { driverId, assignedAt: new Date(), status: 'ASSIGNED' },
    include: { branch: { include: { chain: { select: { id: true } } } } }
  });
  getIO().to(`branch:${order.branchId}`).emit('order:updated', order);
  if (order.branch?.chain?.id) getIO().to(`chain:${order.branch.chain.id}`).emit('order:updated', order);
  getIO().to('admin').emit('order:updated', order);
  getIO().to(`driver:${driverId}`).emit('order:new', order);
  res.json(order);
});

// POST /api/orders/fix-amounts — retroactively fetch & fix amount=0 orders from Talabat API
router.post('/fix-amounts', auth(['SUPER_ADMIN']), async (req, res) => {
  const zeroOrders = await prisma.order.findMany({
    where: { amount: 0 },
    include: { branch: { include: { chain: true } } },
  });

  const results = { fixed: 0, failed: 0, skipped: 0 };

  for (const order of zeroOrders) {
    const chain = order.branch?.chain;
    if (!chain?.talabatClientId || !chain?.talabatChainId) {
      results.skipped++;
      continue;
    }

    try {
      const details = await talabat.getOrderDetails(
        order.talabatOrderId,
        chain.talabatClientId,
        chain.talabatClientSecret,
        chain.talabatChainId
      );

      let amount = 0;
      if (details) {
        amount =
          details.total_value ??
          details.price?.total ??
          details.payment?.collect_at_pickup ??
          0;
      }

      // Fallback: calculate from saved items if API returned nothing
      if (!amount && Array.isArray(order.items) && order.items.length > 0) {
        amount = order.items.reduce((sum, it) => {
          const price = it.price || it.unit_price || it.unitPrice || 0;
          const qty = it.quantity || it.qty || 1;
          return sum + (price * qty);
        }, 0);
      }

      if (amount > 0) {
        await prisma.order.update({ where: { id: order.id }, data: { amount } });
        results.fixed++;
        console.log(`[fix-amounts] Fixed order ${order.talabatOrderId} → ${amount}`);
      } else {
        results.failed++;
        console.log(`[fix-amounts] Could not resolve amount for ${order.talabatOrderId}`);
      }
    } catch (e) {
      results.failed++;
      console.error(`[fix-amounts] Error on ${order.talabatOrderId}:`, e.message);
    }
  }

  res.json({ total: zeroOrders.length, ...results });
});

// POST /orders/test — create a test order for demo/verification
const { assignNearestDriver } = require('../services/assignment');
router.post('/test', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  try {
    const targetBranchId = req.user.role === 'BRANCH_MANAGER' ? req.user.branchId : req.body.branchId;
    if (!targetBranchId) return res.status(400).json({ error: 'branchId مطلوب' });
    const branch = await prisma.branch.findUnique({
      where: { id: targetBranchId },
      include: { chain: { select: { id: true } } }
    });
    if (!branch) return res.status(404).json({ error: 'الفرع غير موجود' });
    const testId = `TEST-${Date.now()}`;
    const newOrder = await prisma.order.create({
      data: {
        talabatOrderId: testId,
        externalOrderId: `T${String(Date.now()).slice(-4)}`,
        status: 'PENDING',
        branchId: targetBranchId,
        customerName: 'عميل تجريبي',
        customerPhone: '01000000000',
        customerAddress: 'عنوان تجريبي للاختبار',
        amount: 150,
        paymentType: 'CASH',
      }
    });
    const driver = await assignNearestDriver(targetBranchId, newOrder.id);
    if (driver) getIO()?.to(`driver:${driver.id}`).emit('order:new', newOrder);
    getIO()?.to(`branch:${targetBranchId}`).emit('order:new', newOrder);
    if (branch.chain?.id) getIO()?.to(`chain:${branch.chain.id}`).emit('order:new', newOrder);
    getIO()?.to('admin').emit('order:new', newOrder);
    res.json({ ok: true, order: newOrder, assignedDriver: driver?.name || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

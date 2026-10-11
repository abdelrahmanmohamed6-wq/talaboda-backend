const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const talabat = require('../services/talabat');

const prisma = new PrismaClient();

// Helper: get order + chain credentials
async function getOrderWithChain(orderId) {
  return prisma.order.findUnique({
    where: { id: orderId },
    include: {
      branch: {
        include: { chain: true }
      }
    }
  });
}

// GET /api/picking/:orderId — جيب الأيتمز الحالية للأوردر
router.get('/:orderId', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const order = await getOrderWithChain(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  // Return stored items + picking status
  res.json({
    orderId: order.id,
    talabatOrderId: order.talabatOrderId,
    externalOrderId: order.externalOrderId,
    status: order.status,
    items: order.items || [],
    pickingItems: order.pickingItems || []
  });
});

// PATCH /api/picking/:orderId/items — تحديث حالة الأيتمز (UPDATE_CART → Talabat)
router.patch('/:orderId/items', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items مطلوبة' });

  const order = await getOrderWithChain(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const chain = order.branch?.chain;
  if (!chain?.talabatChainId || !chain?.talabatClientId) {
    return res.status(400).json({ error: 'الـ chain مش عنده Talabat credentials' });
  }

  // Send UPDATE_CART to Talabat
  await talabat.updateOrder(
    order.talabatOrderId,
    'UPDATE_CART',
    items,
    chain.talabatClientId,
    chain.talabatClientSecret,
    chain.talabatChainId
  );

  // Save picking progress in our DB
  await prisma.order.update({
    where: { id: order.id },
    data: { pickingItems: items, status: 'PREPARING' }
  });

  res.json({ ok: true, message: 'تم تحديث الأيتمز' });
});

// POST /api/picking/:orderId/ready — الأوردر اتحضر (READY_FOR_PICKUP → Talabat)
router.post('/:orderId/ready', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const { items } = req.body;

  const order = await getOrderWithChain(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const chain = order.branch?.chain;
  if (!chain?.talabatChainId || !chain?.talabatClientId) {
    return res.status(400).json({ error: 'الـ chain مش عنده Talabat credentials' });
  }

  const finalItems = items || order.pickingItems || [];

  // Notify Talabat: order is ready for pickup
  await talabat.updateOrder(
    order.talabatOrderId,
    'READY_FOR_PICKUP',
    finalItems,
    chain.talabatClientId,
    chain.talabatClientSecret,
    chain.talabatChainId
  );

  await prisma.order.update({
    where: { id: order.id },
    data: { pickingItems: finalItems, status: 'READY' }
  });

  res.json({ ok: true, message: '✅ تم إبلاغ طلبات — الأوردر جاهز للاستلام' });
});

// POST /api/picking/:orderId/cancel — إلغاء الأوردر من طرف الصيدلية
router.post('/:orderId/cancel', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const { reason = 'VENDOR_UNAVAILABLE' } = req.body;

  const order = await getOrderWithChain(req.params.orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const chain = order.branch?.chain;
  if (!chain?.talabatChainId || !chain?.talabatClientId) {
    return res.status(400).json({ error: 'الـ chain مش عنده Talabat credentials' });
  }

  await talabat.updateOrder(
    order.talabatOrderId,
    'CANCELLED',
    [],
    chain.talabatClientId,
    chain.talabatClientSecret,
    chain.talabatChainId
  );

  await prisma.order.update({
    where: { id: order.id },
    data: { status: 'CANCELLED' }
  });

  res.json({ ok: true, message: 'تم إلغاء الأوردر' });
});

module.exports = router;

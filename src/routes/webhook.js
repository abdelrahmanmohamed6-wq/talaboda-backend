const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { getIO } = require('../socket');
const { assignNearestDriver } = require('../services/assignment');

const prisma = new PrismaClient();

// Talabat sends order status updates here
router.post('/talabat', async (req, res) => {
  const payload = req.body;
  console.log('Talabat webhook:', JSON.stringify(payload, null, 2));

  const { order_id, status, order } = payload;

  if (status === 'READY_FOR_PICKUP' && order) {
    const branch = await prisma.branch.findFirst({
      where: { vendorId: String(order.vendor_id) }
    });
    if (!branch) return res.status(404).json({ error: 'Branch not found' });

    const existing = await prisma.order.findUnique({ where: { talabatOrderId: String(order_id) } });
    if (existing) return res.json({ ok: true });

    const newOrder = await prisma.order.create({
      data: {
        talabatOrderId: String(order_id),
        status: 'PENDING',
        branchId: branch.id,
        customerName: order.customer?.name || 'عميل',
        customerPhone: order.customer?.phone || '',
        customerAddress: order.delivery_address?.description || '',
        customerLat: order.delivery_address?.latitude || null,
        customerLng: order.delivery_address?.longitude || null,
        amount: order.total_value || 0,
        paymentType: order.payment_type === 'online' ? 'CARD' : 'CASH'
      }
    });

    const driver = await assignNearestDriver(branch.id, newOrder.id);
    if (driver) {
      getIO()?.to(`driver:${driver.id}`).emit('order:new', newOrder);
    }
    getIO()?.to(`branch:${branch.id}`).emit('order:new', newOrder);
    getIO()?.to('admin').emit('order:new', newOrder);
  }

  if (status === 'CANCELLED') {
    const existing = await prisma.order.findUnique({ where: { talabatOrderId: String(order_id) } });
    if (existing) {
      await prisma.order.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED' }
      });
      getIO()?.to(`branch:${existing.branchId}`).emit('order:updated', { ...existing, status: 'CANCELLED' });
      if (existing.driverId) {
        getIO()?.to(`driver:${existing.driverId}`).emit('order:cancelled', { orderId: existing.id });
      }
    }
  }

  res.json({ ok: true });
});

module.exports = router;

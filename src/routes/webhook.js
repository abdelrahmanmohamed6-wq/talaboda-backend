const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { getIO } = require('../socket');
const { assignNearestDriver } = require('../services/assignment');
const talabat = require('../services/talabat');

const prisma = new PrismaClient();

router.post('/talabat', async (req, res) => {
  // Verify webhook secret
  const secret = req.headers['x-secret'];
  if (process.env.TALABAT_WEBHOOK_SECRET && secret !== process.env.TALABAT_WEBHOOK_SECRET) {
    console.warn('Talabat webhook: invalid secret');
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const payload = req.body;
  console.log('Talabat webhook:', JSON.stringify(payload, null, 2));

  const { order_id, status } = payload;

  // RECEIVED = sandbox equivalent of READY_FOR_PICKUP
  if ((status === 'READY_FOR_PICKUP' || status === 'RECEIVED') && order_id) {
    // Try to fetch full order details from Talabat API; fall back to webhook payload
    let orderData = payload.order || {};
    try {
      if (process.env.TALABAT_CLIENT_ID) {
        const details = await talabat.getOrderDetails(order_id);
        orderData = details;
      }
    } catch (e) {
      console.warn('Could not fetch Talabat order details, using webhook payload:', e.message);
    }

    const vendorId = String(orderData.vendor_id || payload.vendor_id || '');
    const branch = await prisma.branch.findFirst({ where: { vendorId } });
    if (!branch) {
      console.warn(`No branch found for vendorId: ${vendorId}`);
      return res.status(404).json({ error: 'Branch not found' });
    }

    const existing = await prisma.order.findUnique({ where: { talabatOrderId: String(order_id) } });
    if (existing) return res.json({ ok: true });

    const items = orderData.products || orderData.items || [];

    const newOrder = await prisma.order.create({
      data: {
        talabatOrderId: String(order_id),
        status: 'PENDING',
        talabatStatus: status,
        branchId: branch.id,
        customerName: orderData.customer?.name || orderData.delivery_address?.contact_name || 'عميل',
        customerPhone: orderData.customer?.phone || orderData.delivery_address?.phone_number || '',
        customerAddress: orderData.delivery_address?.description || orderData.delivery_address?.address || '',
        customerLat: orderData.delivery_address?.latitude || null,
        customerLng: orderData.delivery_address?.longitude || null,
        amount: orderData.total_value ?? orderData.price?.total ?? 0,
        paymentType: (orderData.payment_type === 'online' || orderData.payment_type === 'CARD') ? 'CARD' : 'CASH',
        items: items.length > 0 ? items : undefined,
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
    if (existing && existing.status !== 'CANCELLED') {
      const updated = await prisma.order.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED', talabatStatus: 'CANCELLED' }
      });
      getIO()?.to(`branch:${existing.branchId}`).emit('order:updated', updated);
      getIO()?.to('admin').emit('order:updated', updated);
      if (existing.driverId) {
        getIO()?.to(`driver:${existing.driverId}`).emit('order:cancelled', { orderId: existing.id });
      }
    }
  }

  res.json({ ok: true });
});

module.exports = router;

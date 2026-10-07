const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { getIO } = require('../socket');
const { assignNearestDriver } = require('../services/assignment');
const talabat = require('../services/talabat');

const prisma = new PrismaClient();

router.post('/talabat', async (req, res) => {
  const payload = req.body;
  const { order_id, status } = payload;

  console.log(`[webhook] status=${status} order_id=${order_id}`);

  if ((status === 'READY_FOR_PICKUP' || status === 'RECEIVED') && order_id) {

    // Talabat sends store_id inside "client" object (the store/branch info)
    const vendorId = String(
      payload.vendor_id ||
      payload.order?.vendor_id ||
      payload.client?.store_id ||    // current format: client.store_id
      payload.customer?.store_id ||  // older format fallback
      payload.store_id ||
      ''
    );
    console.log(`[webhook] vendorId resolved: "${vendorId}"`);

    if (!vendorId) {
      console.warn('[webhook] vendorId is empty — cannot find branch');
      return res.status(400).json({ error: 'vendorId missing from payload' });
    }

    const branch = await prisma.branch.findFirst({
      where: { vendorId },
      include: { chain: true }
    });

    if (!branch) {
      console.warn(`[webhook] No branch found for vendorId="${vendorId}"`);
      // Log all known vendorIds to help debug
      const allBranches = await prisma.branch.findMany({ select: { id: true, name: true, vendorId: true } });
      console.log('[webhook] Known branches:', JSON.stringify(allBranches));
      return res.status(404).json({ error: 'Branch not found' });
    }
    console.log(`[webhook] Branch found: ${branch.name} (id=${branch.id})`);

    // Verify webhook secret — per-chain or global fallback
    const secret = req.headers['x-secret'];
    const expectedSecret = branch.chain?.talabatWebhookSecret || process.env.TALABAT_WEBHOOK_SECRET;
    if (expectedSecret && secret !== expectedSecret) {
      console.warn(`[webhook] Invalid secret. Got="${secret}" Expected="${expectedSecret}"`);
      return res.status(401).json({ error: 'Invalid secret' });
    }

    const existing = await prisma.order.findUnique({ where: { talabatOrderId: String(order_id) } });
    if (existing) {
      console.log(`[webhook] Order ${order_id} already exists, skipping`);
      return res.json({ ok: true });
    }

    // Fetch full order details from Talabat API using chain credentials
    let orderData = {};
    try {
      const details = await talabat.getOrderDetails(
        order_id,
        branch.chain?.talabatClientId,
        branch.chain?.talabatClientSecret
      );
      if (details) {
        orderData = details;
        console.log('[webhook] Fetched order details from Talabat API');
      }
    } catch (e) {
      console.warn('[webhook] Could not fetch order details from API:', e.message);
      console.log('[webhook] Falling back to webhook payload data');
    }

    // Talabat payload structure:
    // payload.client = store info (name, store_id, phone)
    // payload.customer = actual customer (first_name, delivery_address)
    const delivAddr = payload.customer?.delivery_address || payload.delivery_address || {};

    const customerName =
      orderData.customer?.name ||
      orderData.customer?.first_name ||
      payload.customer?.first_name ||
      payload.customer?.name ||
      delivAddr.contact_name ||
      'عميل';

    const customerPhone =
      orderData.customer?.phone ||
      orderData.customer?.phone_number ||
      payload.customer?.phone_number ||
      payload.customer?.phone ||
      '';

    const customerAddress =
      orderData.delivery_address?.description ||
      orderData.delivery_address?.address ||
      delivAddr.instructions ||
      [
        delivAddr.street,
        delivAddr.number ? `رقم ${delivAddr.number}` : '',
        delivAddr.suburb,
        delivAddr.city
      ].filter(Boolean).join(', ') ||
      '';

    const customerLat =
      orderData.delivery_address?.latitude ||
      delivAddr.latitude ||
      null;

    const customerLng =
      orderData.delivery_address?.longitude ||
      delivAddr.longitude ||
      null;

    const amount =
      orderData.total_value ??
      orderData.price?.total ??
      payload.price?.total ??
      0;

    const paymentRaw = orderData.payment_type || payload.payment?.type || '';
    const paymentType = (paymentRaw === 'online' || paymentRaw === 'CARD' || paymentRaw === 'PAID')
      ? 'CARD'
      : 'CASH';

    const items = orderData.products || orderData.items || payload.items || [];

    console.log(`[webhook] Creating order: customer="${customerName}" amount=${amount} payment=${paymentType}`);

    try {
      const newOrder = await prisma.order.create({
        data: {
          talabatOrderId: String(order_id),
          status: 'PENDING',
          talabatStatus: status,
          branchId: branch.id,
          customerName,
          customerPhone,
          customerAddress,
          customerLat,
          customerLng,
          amount,
          paymentType,
          items: items.length > 0 ? items : undefined,
        }
      });
      console.log(`[webhook] ✅ Order created: ${newOrder.id}`);

      const driver = await assignNearestDriver(branch.id, newOrder.id);
      if (driver) {
        console.log(`[webhook] Driver assigned: ${driver.name}`);
        getIO()?.to(`driver:${driver.id}`).emit('order:new', newOrder);
      } else {
        console.log('[webhook] No driver assigned (none available)');
      }
      getIO()?.to(`branch:${branch.id}`).emit('order:new', newOrder);
      getIO()?.to('admin').emit('order:new', newOrder);

    } catch (err) {
      console.error('[webhook] ❌ Failed to create order:', err.message);
      return res.status(500).json({ error: 'Failed to save order' });
    }
  }

  if (status === 'CANCELLED' && order_id) {
    const existing = await prisma.order.findUnique({ where: { talabatOrderId: String(order_id) } });
    if (existing && existing.status !== 'CANCELLED') {
      const updated = await prisma.order.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED', talabatStatus: 'CANCELLED' }
      });
      console.log(`[webhook] Order ${order_id} marked CANCELLED`);
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

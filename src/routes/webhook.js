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
  // Log full payload for unknown statuses — helps debug what Talabat sends
  const HANDLED = ['READY_FOR_PICKUP', 'RECEIVED', 'ACCEPTED', 'CANCELLED'];
  if (!HANDLED.includes(status)) {
    console.log('[webhook] ⚠️ Unhandled status. Full payload:', JSON.stringify(payload, null, 2));
  }

  if ((status === 'READY_FOR_PICKUP' || status === 'RECEIVED' || status === 'ACCEPTED') && order_id) {

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
        branch.chain?.talabatClientSecret,
        branch.chain?.talabatChainId
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
      orderData.total_value ||
      orderData.price?.total ||
      orderData.grand_total ||
      payload.price?.total ||
      payload.grand_total ||
      payload.subtotal ||
      payload.payment?.grand_total ||
      payload.payment?.collect_at_pickup ||
      payload.payment?.subtotal ||
      payload.payment?.amount ||
      0;

    // Log all amount-related fields when amount is 0 so we can debug
    if (!amount) {
      console.warn('[webhook] ⚠️ Amount is 0 — raw amount fields:', JSON.stringify({
        'orderData.total_value': orderData.total_value,
        'orderData.price': orderData.price,
        'orderData.grand_total': orderData.grand_total,
        'payload.price': payload.price,
        'payload.grand_total': payload.grand_total,
        'payload.subtotal': payload.subtotal,
        'payload.payment': payload.payment,
      }, null, 2));
    }

    // Promised delivery time — try multiple field names Talabat might use
    const promisedRaw =
      orderData.promised_delivery_time ||
      orderData.promised_at ||
      orderData.estimated_delivery_time ||
      orderData.delivery_time ||
      payload.promised_delivery_time ||
      payload.promised_at ||
      payload.delivery_time ||
      payload.eta ||
      null;
    const promisedAt = promisedRaw ? new Date(promisedRaw) : null;

    const paymentRaw = orderData.payment_type || payload.payment?.type || '';
    const paymentType = (paymentRaw === 'online' || paymentRaw === 'CARD' || paymentRaw === 'PAID')
      ? 'CARD'
      : 'CASH';

    const items = orderData.products || orderData.items || payload.items || [];

    // Short numeric Talabat order ID (e.g. 3770) — may come from payload or API details
    const externalOrderId = String(
      orderData.external_order_id || orderData.order_number || orderData.reference_id ||
      payload.external_order_id || payload.order_number || payload.reference_id || ''
    ) || null;

    console.log(`[webhook] Creating order: customer="${customerName}" amount=${amount} payment=${paymentType} extId=${externalOrderId}`);

    try {
      const newOrder = await prisma.order.create({
        data: {
          talabatOrderId: String(order_id),
          externalOrderId,
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
          promisedAt,
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

      // Auto-close check: if branch overwhelmed (≥5 pending + no free drivers) → close on Talabat
      autoCloseIfOverwhelmed(branch).catch(e => console.error('[webhook] auto-close check error:', e.message));

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

async function autoCloseIfOverwhelmed(branch) {
  const chain = branch.chain;
  if (!chain?.talabatClientId || !chain?.talabatChainId || !branch.vendorId) return;

  const [pendingCount, freeDriverCount] = await Promise.all([
    prisma.order.count({
      where: { branchId: branch.id, status: { in: ['PENDING', 'ASSIGNED'] } },
    }),
    prisma.user.count({
      where: {
        branchId: branch.id, role: 'DRIVER', isActive: true,
        shifts: { some: { status: 'ACTIVE' } },
        orders: { none: { status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } } },
      },
    }),
  ]);

  if (pendingCount >= 5 && freeDriverCount === 0) {
    console.log(`[webhook] Auto-closing branch "${branch.name}" — pending=${pendingCount}, freeDrivers=0`);
    const closedUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min
    await talabat.setVendorStatus(
      branch.vendorId, false,
      chain.talabatClientId, chain.talabatClientSecret, chain.talabatChainId,
      closedUntil
    );
  }
}

module.exports = router;

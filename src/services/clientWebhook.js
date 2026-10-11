const axios = require('axios');
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const EVENT_MAP = {
  PENDING:    'ORDER_RECEIVED',
  ASSIGNED:   'ORDER_ASSIGNED',
  PICKED_UP:  'ORDER_PICKED_UP',
  IN_TRANSIT: 'ORDER_IN_TRANSIT',
  DELIVERED:  'ORDER_DELIVERED',
  CANCELLED:  'ORDER_CANCELLED',
};

async function notifyClient(orderId) {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        branch: { include: { chain: true } },
        driver: { select: { id: true, name: true, phone: true } },
      },
    });
    if (!order) return;

    const chain = order.branch?.chain;
    if (!chain?.clientWebhookUrl) return;

    // Latest driver location
    let driverLocation = null;
    if (order.driverId) {
      const loc = await prisma.driverLocation.findFirst({
        where: { driverId: order.driverId },
        orderBy: { timestamp: 'desc' },
      });
      if (loc) driverLocation = { lat: loc.lat, lng: loc.lng, updatedAt: loc.timestamp };
    }

    const event = EVENT_MAP[order.status] || order.status;
    const payload = {
      event,
      orderId: order.talabatOrderId,
      externalOrderId: order.externalOrderId,
      status: order.status,
      customerName: order.customerName,
      customerAddress: order.customerAddress,
      amount: order.amount,
      paymentType: order.paymentType,
      driver: order.driver
        ? { name: order.driver.name, phone: order.driver.phone }
        : null,
      driverLocation,
      timestamps: {
        createdAt: order.createdAt,
        assignedAt: order.assignedAt,
        pickedUpAt: order.pickedUpAt,
        deliveredAt: order.deliveredAt,
      },
      timestamp: new Date().toISOString(),
    };

    const headers = { 'Content-Type': 'application/json' };
    if (chain.clientWebhookSecret) {
      const sig = crypto
        .createHmac('sha256', chain.clientWebhookSecret)
        .update(JSON.stringify(payload))
        .digest('hex');
      headers['X-TalaBoda-Signature'] = `sha256=${sig}`;
    }

    await axios.post(chain.clientWebhookUrl, payload, { headers, timeout: 10000 });
    console.log(`[clientWebhook] ${event} → ${chain.clientWebhookUrl} (order ${order.talabatOrderId})`);
  } catch (e) {
    console.error('[clientWebhook] Failed to notify client:', e.message);
  }
}

module.exports = { notifyClient };

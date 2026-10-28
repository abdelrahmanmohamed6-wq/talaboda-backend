const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

async function sendPushToDriver(driverId, { title, body, data = {} }) {
  try {
    const driver = await prisma.user.findUnique({ where: { id: driverId }, select: { pushToken: true } });
    if (!driver?.pushToken) return;

    await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        to: driver.pushToken,
        title,
        body,
        data,
        sound: 'default',
        priority: 'high',
        channelId: 'orders',
      }),
    });
  } catch (e) {
    console.warn('[push] Failed to send notification:', e.message);
  }
}

module.exports = { sendPushToDriver };

const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// GET /api/tracking/:id — public, no auth
// :id = talabatOrderId OR externalOrderId (the short Talabat number)
router.get('/:id', async (req, res) => {
  const order = await prisma.order.findFirst({
    where: {
      OR: [
        { talabatOrderId: req.params.id },
        { externalOrderId: req.params.id },
      ],
    },
    include: {
      driver: { select: { id: true, name: true } },
      branch: { select: { name: true, lat: true, lng: true } },
    },
  });

  if (!order) return res.status(404).json({ error: 'Order not found' });

  let driverLocation = null;
  if (order.driverId) {
    const loc = await prisma.driverLocation.findFirst({
      where: { driverId: order.driverId },
      orderBy: { timestamp: 'desc' },
    });
    if (loc) driverLocation = { lat: loc.lat, lng: loc.lng, updatedAt: loc.timestamp };
  }

  res.json({
    orderId: order.talabatOrderId,
    externalOrderId: order.externalOrderId,
    status: order.status,
    driver: order.driver
      ? { name: order.driver.name, location: driverLocation }
      : null,
    branch: order.branch
      ? { name: order.branch.name, lat: order.branch.lat, lng: order.branch.lng }
      : null,
    promisedAt: order.promisedAt,
    pickedUpAt: order.pickedUpAt,
    deliveredAt: order.deliveredAt,
    updatedAt: new Date().toISOString(),
  });
});

module.exports = router;

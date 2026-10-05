const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function getDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function assignNearestDriver(branchId, orderId) {
  const branch = await prisma.branch.findUnique({ where: { id: branchId } });

  const availableDrivers = await prisma.user.findMany({
    where: {
      branchId,
      role: 'DRIVER',
      isActive: true,
      shifts: { some: { status: 'ACTIVE' } },
      orders: { none: { status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } } }
    },
    include: {
      locations: { orderBy: { timestamp: 'desc' }, take: 1 }
    }
  });

  if (!availableDrivers.length) return null;

  let nearest = null;
  let minDist = Infinity;

  for (const driver of availableDrivers) {
    const loc = driver.locations[0];
    if (!loc) {
      if (!nearest) nearest = driver;
      continue;
    }
    const dist = getDistance(branch.lat, branch.lng, loc.lat, loc.lng);
    if (dist < minDist) {
      minDist = dist;
      nearest = driver;
    }
  }

  if (!nearest) return null;

  const shift = await prisma.shift.findFirst({ where: { driverId: nearest.id, status: 'ACTIVE' } });

  await prisma.order.update({
    where: { id: orderId },
    data: { driverId: nearest.id, status: 'ASSIGNED', assignedAt: new Date(), shiftId: shift?.id }
  });

  return nearest;
}

module.exports = { assignNearestDriver };

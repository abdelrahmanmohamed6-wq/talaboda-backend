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
  const order = await prisma.order.findUnique({ where: { id: orderId } });

  // All drivers with active shift — include their current active orders
  const candidates = await prisma.user.findMany({
    where: {
      branchId,
      role: 'DRIVER',
      isActive: true,
      shifts: { some: { status: 'ACTIVE' } },
    },
    include: {
      locations: { orderBy: { timestamp: 'desc' }, take: 1 },
      orders: {
        where: { status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } },
        select: { id: true, customerLat: true, customerLng: true },
      },
    },
  });

  // Max 2 active orders per driver
  const eligible = candidates.filter(d => d.orders.length < 2);
  if (!eligible.length) {
    console.log(`[assignment] No eligible driver for order ${orderId} (all at max capacity)`);
    return null;
  }

  // Priority 1: driver with exactly 1 active order whose delivery is within 3 km of new order
  if (order?.customerLat && order?.customerLng) {
    const withOne = eligible.filter(d => d.orders.length === 1);
    let bestClustered = null;
    let minClusterDist = 3; // km threshold

    for (const driver of withOne) {
      const existing = driver.orders[0];
      if (!existing?.customerLat || !existing?.customerLng) continue;
      const dist = getDistance(
        existing.customerLat, existing.customerLng,
        order.customerLat, order.customerLng
      );
      if (dist < minClusterDist) {
        minClusterDist = dist;
        bestClustered = driver;
      }
    }

    if (bestClustered) {
      console.log(`[assignment] Clustered order ${orderId} → driver ${bestClustered.name} (dist=${minClusterDist.toFixed(2)} km)`);
      const shift = await prisma.shift.findFirst({ where: { driverId: bestClustered.id, status: 'ACTIVE' } });
      await prisma.order.update({
        where: { id: orderId },
        data: { driverId: bestClustered.id, status: 'ASSIGNED', assignedAt: new Date(), shiftId: shift?.id },
      });
      return bestClustered;
    }
  }

  // Priority 2: nearest free driver (0 active orders) → else nearest with 1 order
  const freeDrivers = eligible.filter(d => d.orders.length === 0);
  const pool = freeDrivers.length > 0 ? freeDrivers : eligible;

  let nearest = null;
  let minDist = Infinity;

  for (const driver of pool) {
    const loc = driver.locations[0];
    if (!loc) {
      if (!nearest) nearest = driver;
      continue;
    }
    const dist = getDistance(branch?.lat ?? 0, branch?.lng ?? 0, loc.lat, loc.lng);
    if (dist < minDist) {
      minDist = dist;
      nearest = driver;
    }
  }

  if (!nearest) return null;

  console.log(`[assignment] Assigned order ${orderId} → driver ${nearest.name} (dist=${minDist === Infinity ? '?' : minDist.toFixed(2)} km)`);
  const shift = await prisma.shift.findFirst({ where: { driverId: nearest.id, status: 'ACTIVE' } });
  await prisma.order.update({
    where: { id: orderId },
    data: { driverId: nearest.id, status: 'ASSIGNED', assignedAt: new Date(), shiftId: shift?.id },
  });

  return nearest;
}

module.exports = { assignNearestDriver };

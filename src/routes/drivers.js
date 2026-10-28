const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { getIO } = require('../socket');

const prisma = new PrismaClient();

router.get('/', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const where =
    req.user.role === 'BRANCH_MANAGER' ? { branchId: req.user.branchId } :
    req.user.role === 'CHAIN_OWNER' ? { branch: { chainId: req.user.chainId } } :
    {};
  const drivers = await prisma.user.findMany({
    where: { ...where, role: 'DRIVER' },
    select: {
      id: true, name: true, phone: true, role: true, isActive: true, createdAt: true, branchId: true,
      orders: { where: { status: { in: ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'] } } },
      shifts: { where: { status: 'ACTIVE' }, take: 1 }
    }
  });
  res.json(drivers);
});

router.post('/', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const { name, phone, password } = req.body;
  const branchId = req.user.role === 'BRANCH_MANAGER' ? req.user.branchId : req.body.branchId;
  const hashed = await bcrypt.hash(password, 10);
  const driver = await prisma.user.create({
    data: { name, phone, password: hashed, role: 'DRIVER', branchId }
  });
  res.json({ id: driver.id, name: driver.name, phone: driver.phone });
});

router.patch('/:id/toggle', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const driver = await prisma.user.findUnique({ where: { id: req.params.id } });
  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: { isActive: !driver.isActive }
  });
  res.json({ isActive: updated.isActive });
});

router.patch('/:id', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const { name, phone } = req.body;
  const driver = await prisma.user.update({
    where: { id: req.params.id },
    data: { name, phone },
    select: { id: true, name: true, phone: true }
  });
  res.json(driver);
});

router.delete('/:id', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const id = req.params.id;
  const driver = await prisma.user.findUnique({ where: { id }, include: { branch: true } });
  if (!driver || driver.role !== 'DRIVER') return res.status(404).json({ error: 'Driver not found' });
  if (req.user.role === 'BRANCH_MANAGER' && driver.branchId !== req.user.branchId) return res.status(403).json({ error: 'Forbidden' });
  if (req.user.role === 'CHAIN_OWNER' && driver.branch?.chainId !== req.user.chainId) return res.status(403).json({ error: 'Forbidden' });

  // A plain user.delete fails with an FK violation once the driver has orders, shifts,
  // locations or tickets. Keep the orders (history) but detach them from the driver.
  await prisma.$transaction(async (tx) => {
    const shiftIds = (await tx.shift.findMany({ where: { driverId: id }, select: { id: true } })).map(x => x.id);
    await tx.supportTicket.deleteMany({ where: { driverId: id } });
    await tx.order.updateMany({ where: { OR: [{ driverId: id }, { shiftId: { in: shiftIds } }] }, data: { driverId: null, shiftId: null } });
    await tx.shift.deleteMany({ where: { driverId: id } });
    await tx.driverLocation.deleteMany({ where: { driverId: id } });
    await tx.user.delete({ where: { id } });
  });
  res.json({ ok: true });
});

router.get('/:id/stats', auth(), async (req, res) => {
  const driverId = req.user.role === 'DRIVER' ? req.user.id : req.params.id;
  const shift = await prisma.shift.findFirst({
    where: { driverId, status: 'ACTIVE' },
    include: { orders: true }
  });
  res.json(shift);
});

// GET /drivers/last-locations — latest location per active driver (for dashboard initial load)
router.get('/last-locations', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const where =
    req.user.role === 'BRANCH_MANAGER' ? { branchId: req.user.branchId } :
    req.user.role === 'CHAIN_OWNER' ? { branch: { chainId: req.user.chainId } } :
    {};
  const drivers = await prisma.user.findMany({
    where: { ...where, role: 'DRIVER', isActive: true },
    select: {
      id: true, name: true,
      locations: { orderBy: { timestamp: 'desc' }, take: 1 }
    }
  });
  const eightHoursAgo = new Date(Date.now() - 8 * 60 * 60 * 1000);
  const result = drivers
    .filter(d => d.locations.length > 0 && d.locations[0].timestamp > eightHoursAgo)
    .map(d => ({ driverId: d.id, name: d.name, lat: d.locations[0].lat, lng: d.locations[0].lng }));
  res.json(result);
});

// HTTP fallback for background location updates (when socket is unavailable)
router.post('/location', auth(['DRIVER']), async (req, res) => {
  const { lat, lng } = req.body;
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat/lng required' });
  const { id: driverId, branchId, chainId } = req.user;
  const payload = { driverId, lat: +lat, lng: +lng, timestamp: new Date() };
  const io = getIO();
  if (branchId) io?.to(`branch:${branchId}`).emit('driver:location', payload);
  if (chainId) io?.to(`chain:${chainId}`).emit('driver:location', payload);
  io?.to('admin').emit('driver:location', payload);
  try { await prisma.driverLocation.create({ data: { driverId, lat: +lat, lng: +lng } }); } catch {}
  res.json({ ok: true });
});

module.exports = router;

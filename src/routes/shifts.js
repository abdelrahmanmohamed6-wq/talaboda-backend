const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();

// Driver starts own shift
router.post('/start', auth(['DRIVER']), async (req, res) => {
  const existing = await prisma.shift.findFirst({ where: { driverId: req.user.id, status: 'ACTIVE' } });
  if (existing) return res.status(400).json({ error: 'عندك شيفت نشط بالفعل' });
  const shift = await prisma.shift.create({ data: { driverId: req.user.id } });
  res.json(shift);
});

// Admin opens shift for a specific driver
router.post('/admin-open', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const { driverId } = req.body;
  if (!driverId) return res.status(400).json({ error: 'driverId مطلوب' });
  const existing = await prisma.shift.findFirst({ where: { driverId, status: 'ACTIVE' } });
  if (existing) return res.status(400).json({ error: 'الطيار عنده شيفت نشط بالفعل' });
  const shift = await prisma.shift.create({
    data: { driverId },
    include: { driver: { select: { id: true, name: true, phone: true } } }
  });
  res.json(shift);
});

// Admin collects debt and ends shift
router.post('/:id/collect', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const shift = await prisma.shift.findUnique({ where: { id: req.params.id } });
  if (!shift) return res.status(404).json({ error: 'الشيفت مش موجود' });
  if (shift.status !== 'ACTIVE') return res.status(400).json({ error: 'الشيفت مش نشط' });
  const ended = await prisma.shift.update({
    where: { id: req.params.id },
    data: { status: 'ENDED', endTime: new Date() },
    include: { driver: { select: { id: true, name: true } } }
  });
  res.json(ended);
});

// Driver checks own active shift
router.get('/my', auth(['DRIVER']), async (req, res) => {
  const shift = await prisma.shift.findFirst({
    where: { driverId: req.user.id, status: 'ACTIVE' },
    include: { orders: { where: { status: 'DELIVERED' } } }
  });
  res.json(shift);
});

// Driver ends own shift
router.post('/end', auth(['DRIVER']), async (req, res) => {
  const shift = await prisma.shift.findFirst({
    where: { driverId: req.user.id, status: 'ACTIVE' },
    include: { orders: true }
  });
  if (!shift) return res.status(404).json({ error: 'لا يوجد شيفت نشط' });

  const hasActiveOrders = shift.orders.some(o =>
    ['ASSIGNED', 'PICKED_UP', 'IN_TRANSIT'].includes(o.status)
  );
  if (hasActiveOrders) return res.status(400).json({ error: 'عندك أوردرات لسه مش سلّمتها' });

  const ended = await prisma.shift.update({
    where: { id: shift.id },
    data: { status: 'ENDED', endTime: new Date() },
    include: { orders: { where: { status: 'DELIVERED' } } }
  });
  res.json(ended);
});

// Get all shifts (admin) or branch shifts
router.get('/', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const where = req.user.role === 'BRANCH_MANAGER'
    ? { driver: { branchId: req.user.branchId } }
    : {};
  const shifts = await prisma.shift.findMany({
    where,
    include: {
      driver: {
        select: {
          id: true, name: true, phone: true, role: true, isActive: true,
          branch: { select: { id: true, name: true, chain: { select: { id: true, name: true } } } }
        }
      },
      orders: true
    },
    orderBy: { startTime: 'desc' },
    take: 100
  });
  res.json(shifts);
});

module.exports = router;

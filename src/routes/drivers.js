const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

router.get('/', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const where = req.user.role === 'BRANCH_MANAGER' ? { branchId: req.user.branchId } : {};
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

router.post('/', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const { name, phone, password } = req.body;
  const branchId = req.user.role === 'BRANCH_MANAGER' ? req.user.branchId : req.body.branchId;
  const hashed = await bcrypt.hash(password, 10);
  const driver = await prisma.user.create({
    data: { name, phone, password: hashed, role: 'DRIVER', branchId }
  });
  res.json({ id: driver.id, name: driver.name, phone: driver.phone });
});

router.patch('/:id/toggle', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const driver = await prisma.user.findUnique({ where: { id: req.params.id } });
  const updated = await prisma.user.update({
    where: { id: req.params.id },
    data: { isActive: !driver.isActive }
  });
  res.json({ isActive: updated.isActive });
});

router.patch('/:id', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const { name, phone } = req.body;
  const driver = await prisma.user.update({
    where: { id: req.params.id },
    data: { name, phone },
    select: { id: true, name: true, phone: true }
  });
  res.json(driver);
});

router.delete('/:id', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  await prisma.user.delete({ where: { id: req.params.id } });
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

module.exports = router;

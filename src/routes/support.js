const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();

router.post('/', auth(['DRIVER']), async (req, res) => {
  const { message, orderId } = req.body;
  const ticket = await prisma.supportTicket.create({
    data: { message, driverId: req.user.id, orderId: orderId || null }
  });
  res.json(ticket);
});

router.get('/', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const where = req.user.role === 'BRANCH_MANAGER'
    ? { driver: { branchId: req.user.branchId } }
    : {};
  const tickets = await prisma.supportTicket.findMany({
    where,
    include: { driver: { omit: { password: true } }, order: true },
    orderBy: { createdAt: 'desc' }
  });
  res.json(tickets);
});

router.patch('/:id/resolve', auth(['SUPER_ADMIN', 'BRANCH_MANAGER']), async (req, res) => {
  const ticket = await prisma.supportTicket.update({
    where: { id: req.params.id },
    data: { status: 'RESOLVED' }
  });
  res.json(ticket);
});

module.exports = router;

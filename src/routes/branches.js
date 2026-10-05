const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

router.get('/', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const where =
    req.user.role === 'BRANCH_MANAGER' ? { id: req.user.branchId } :
    req.user.role === 'CHAIN_OWNER'    ? { chainId: req.user.chainId } :
    {};

  const branches = await prisma.branch.findMany({
    where,
    include: {
      drivers: {
        where: { role: 'DRIVER' },
        select: { id: true, name: true, phone: true, role: true, isActive: true, createdAt: true, branchId: true }
      },
      _count: { select: { orders: true } }
    }
  });
  res.json(branches);
});

router.post('/', auth(['SUPER_ADMIN', 'CHAIN_OWNER']), async (req, res) => {
  const { name, lat, lng, vendorId, managerName, managerEmail, managerPassword } = req.body;
  const chainId = req.user.role === 'CHAIN_OWNER' ? req.user.chainId : req.body.chainId;
  const branch = await prisma.branch.create({ data: { name, lat: +lat, lng: +lng, vendorId, chainId } });

  if (managerEmail && managerPassword) {
    const hashed = await bcrypt.hash(managerPassword, 10);
    await prisma.user.create({
      data: { name: managerName || name, email: managerEmail, password: hashed, role: 'BRANCH_MANAGER', branchId: branch.id }
    });
  }

  res.json(branch);
});

router.patch('/:id', auth(['SUPER_ADMIN', 'CHAIN_OWNER']), async (req, res) => {
  const { name, lat, lng, vendorId } = req.body;
  const branch = await prisma.branch.update({
    where: { id: req.params.id },
    data: { name, lat, lng, vendorId }
  });
  res.json(branch);
});

router.delete('/:id', auth(['SUPER_ADMIN', 'CHAIN_OWNER']), async (req, res) => {
  await prisma.branch.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

router.post('/:id/managers', auth(['SUPER_ADMIN', 'CHAIN_OWNER']), async (req, res) => {
  const { name, phone, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  const manager = await prisma.user.create({
    data: { name, phone, password: hashed, role: 'BRANCH_MANAGER', branchId: req.params.id }
  });
  res.json({ id: manager.id, name: manager.name, phone: manager.phone });
});

module.exports = router;

const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const talabat = require('../services/talabat');

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
  const dup = await prisma.branch.findFirst({ where: { vendorId: String(vendorId) } });
  if (dup) return res.status(409).json({ error: `Vendor ID ${vendorId} مستخدم بالفعل في فرع "${dup.name}"` });
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
  if (vendorId) {
    const dup = await prisma.branch.findFirst({ where: { vendorId: String(vendorId), NOT: { id: req.params.id } } });
    if (dup) return res.status(409).json({ error: `Vendor ID ${vendorId} مستخدم بالفعل في فرع "${dup.name}"` });
  }
  const branch = await prisma.branch.update({
    where: { id: req.params.id },
    data: { name, lat, lng, vendorId }
  });
  res.json(branch);
});

router.delete('/:id', auth(['SUPER_ADMIN', 'CHAIN_OWNER']), async (req, res) => {
  // Delete the branch together with everything that references it, in FK order.
  // A plain branch.delete fails (FK violation) once the branch has orders or drivers,
  // which left the branch in the database while the dashboard looked like it was gone.
  const id = req.params.id;
  await prisma.$transaction(async (tx) => {
    const driverIds = (await tx.user.findMany({ where: { branchId: id }, select: { id: true } })).map(u => u.id);
    await tx.supportTicket.deleteMany({ where: { OR: [{ order: { branchId: id } }, { driverId: { in: driverIds } }] } });
    await tx.order.deleteMany({ where: { branchId: id } });
    await tx.order.updateMany({ where: { driverId: { in: driverIds } }, data: { driverId: null } });
    await tx.shift.deleteMany({ where: { driverId: { in: driverIds } } });
    await tx.driverLocation.deleteMany({ where: { driverId: { in: driverIds } } });
    await tx.user.deleteMany({ where: { branchId: id } });
    await tx.branch.delete({ where: { id } });
  });
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

// POST /branches/:id/close — close this branch on Talabat
router.post('/:id/close', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const branch = await prisma.branch.findUnique({
    where: { id: req.params.id },
    include: { chain: true },
  });
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  const { closedUntilIso } = req.body; // optional override, defaults to 30 min
  try {
    await talabat.setVendorStatus(
      branch.vendorId, false,
      branch.chain?.talabatClientId, branch.chain?.talabatClientSecret, branch.chain?.talabatChainId,
      closedUntilIso
    );
    res.json({ ok: true, message: `Branch "${branch.name}" closed on Talabat` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /branches/:id/open — reopen this branch on Talabat
router.post('/:id/open', auth(['SUPER_ADMIN', 'CHAIN_OWNER', 'BRANCH_MANAGER']), async (req, res) => {
  const branch = await prisma.branch.findUnique({
    where: { id: req.params.id },
    include: { chain: true },
  });
  if (!branch) return res.status(404).json({ error: 'Branch not found' });
  try {
    await talabat.setVendorStatus(
      branch.vendorId, true,
      branch.chain?.talabatClientId, branch.chain?.talabatClientSecret, branch.chain?.talabatChainId
    );
    res.json({ ok: true, message: `Branch "${branch.name}" opened on Talabat` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

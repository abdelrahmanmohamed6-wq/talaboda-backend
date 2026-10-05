const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');

const prisma = new PrismaClient();

router.post('/login', async (req, res) => {
  const { phone, email, password } = req.body;
  const identifier = email || phone;

  const user = await prisma.user.findFirst({
    where: { OR: [{ phone: identifier }, { email: identifier }] },
    include: { branch: true, ownedChain: true }
  });

  if (!user || !await bcrypt.compare(password, user.password)) {
    return res.status(401).json({ error: 'بيانات غلط' });
  }
  if (!user.isActive) return res.status(403).json({ error: 'الحساب موقوف' });

  const token = jwt.sign(
    { id: user.id, role: user.role, branchId: user.branchId, chainId: user.ownedChain?.id },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json({
    token,
    user: {
      id: user.id, name: user.name, phone: user.phone, email: user.email,
      role: user.role, branch: user.branch, chain: user.ownedChain
    }
  });
});

router.get('/me', auth(), async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true, name: true, phone: true, email: true, role: true,
      isActive: true, createdAt: true, branchId: true, branch: true,
      ownedChain: true
    }
  });
  res.json(user);
});

router.get('/seed-admin', async (req, res) => {
  const existing = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
  if (existing) return res.json({ message: 'Admin already exists' });
  const password = await bcrypt.hash('admin123', 10);
  const admin = await prisma.user.create({
    data: { name: 'Super Admin', phone: '01000000000', password, role: 'SUPER_ADMIN' }
  });
  res.json({ message: 'Admin created', phone: admin.phone, password: 'admin123' });
});

module.exports = router;

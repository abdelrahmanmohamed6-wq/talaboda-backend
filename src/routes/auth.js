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

// Change own password
router.patch('/change-password', auth(), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'الحقول مطلوبة' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'كلمة السر لازم تكون 6 أحرف على الأقل' });

  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!await bcrypt.compare(currentPassword, user.password)) {
    return res.status(401).json({ error: 'كلمة السر الحالية غلط' });
  }
  await prisma.user.update({
    where: { id: req.user.id },
    data: { password: await bcrypt.hash(newPassword, 10) }
  });
  res.json({ message: 'تم تغيير كلمة السر' });
});

// Create another SUPER_ADMIN (SUPER_ADMIN only)
router.post('/create-admin', auth(['SUPER_ADMIN']), async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !password || (!email && !phone)) {
    return res.status(400).json({ error: 'الاسم وكلمة السر وإيميل أو تليفون مطلوبين' });
  }
  const existing = await prisma.user.findFirst({
    where: { OR: [email ? { email } : {}, phone ? { phone } : {}].filter(o => Object.keys(o).length > 0) }
  });
  if (existing) return res.status(409).json({ error: 'الإيميل أو التليفون موجود بالفعل' });

  const hashed = await bcrypt.hash(password, 10);
  const admin = await prisma.user.create({
    data: { name, email: email || null, phone: phone || null, password: hashed, role: 'SUPER_ADMIN' }
  });
  res.json({ message: 'تم إنشاء الأدمن', admin: { id: admin.id, name: admin.name, email: admin.email, phone: admin.phone } });
});

module.exports = router;

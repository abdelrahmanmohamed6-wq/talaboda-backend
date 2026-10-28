const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const auth = require('../middleware/auth');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

// Get all chains (super admin only)
router.get('/', auth(['SUPER_ADMIN']), async (req, res) => {
  const chains = await prisma.chain.findMany({
    include: {
      owner: { select: { id: true, name: true, email: true, phone: true } },
      branches: {
        include: {
          drivers: { where: { role: 'DRIVER' }, select: { id: true, name: true, isActive: true } },
          _count: { select: { orders: true } }
        }
      }
    },
    orderBy: { createdAt: 'desc' }
  });
  res.json(chains);
});

// Get my chain (chain owner) — must be before /:id
router.get('/mine', auth(['CHAIN_OWNER']), async (req, res) => {
  const chain = await prisma.chain.findUnique({
    where: { id: req.user.chainId },
    include: {
      branches: {
        include: {
          drivers: { select: { id: true, name: true, phone: true, isActive: true } },
          _count: { select: { orders: true } }
        }
      }
    }
  });
  res.json(chain);
});

// Get single chain with all credentials (super admin only)
router.get('/:id', auth(['SUPER_ADMIN']), async (req, res) => {
  const chain = await prisma.chain.findUnique({
    where: { id: req.params.id },
    include: {
      owner: { select: { id: true, name: true, email: true } },
      branches: { include: { drivers: { where: { role: 'DRIVER' }, select: { id: true, name: true } } } }
    }
  });
  res.json(chain);
});

// Create chain + owner account (super admin only)
router.post('/', auth(['SUPER_ADMIN']), async (req, res) => {
  const { chainName, ownerName, ownerEmail, ownerPassword, talabatClientId, talabatClientSecret, talabatChainId, talabatWebhookSecret, clientWebhookUrl, clientWebhookSecret } = req.body;
  const hashed = await bcrypt.hash(ownerPassword, 10);

  const owner = await prisma.user.create({
    data: { name: ownerName, email: ownerEmail, password: hashed, role: 'CHAIN_OWNER' }
  });

  const chain = await prisma.chain.create({
    data: {
      name: chainName,
      ownerId: owner.id,
      talabatClientId: talabatClientId || null,
      talabatClientSecret: talabatClientSecret || null,
      talabatChainId: talabatChainId || null,
      talabatWebhookSecret: talabatWebhookSecret || null,
      clientWebhookUrl: clientWebhookUrl || null,
      clientWebhookSecret: clientWebhookSecret || null,
    },
    include: { owner: { select: { id: true, name: true, email: true } } }
  });

  res.json(chain);
});

// Update chain
router.patch('/:id', auth(['SUPER_ADMIN']), async (req, res) => {
  const { name, talabatClientId, talabatClientSecret, talabatChainId, talabatWebhookSecret, clientWebhookUrl, clientWebhookSecret, ownerName, ownerEmail, ownerPassword } = req.body;

  // Edit the chain owner account (name / email / password) without deleting the chain
  if (ownerName !== undefined || ownerEmail !== undefined || ownerPassword) {
    const existing = await prisma.chain.findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Chain not found' });
    if (ownerEmail) {
      const taken = await prisma.user.findFirst({ where: { email: ownerEmail, NOT: { id: existing.ownerId } } });
      if (taken) return res.status(409).json({ error: 'الإيميل ده مستخدم بالفعل' });
    }
    await prisma.user.update({
      where: { id: existing.ownerId },
      data: {
        ...(ownerName && { name: ownerName }),
        ...(ownerEmail && { email: ownerEmail }),
        ...(ownerPassword && { password: await bcrypt.hash(ownerPassword, 10) }),
      }
    });
  }

  const chain = await prisma.chain.update({
    where: { id: req.params.id },
    data: {
      ...(name !== undefined && { name }),
      ...(talabatClientId !== undefined && { talabatClientId: talabatClientId || null }),
      ...(talabatClientSecret !== undefined && { talabatClientSecret: talabatClientSecret || null }),
      ...(talabatChainId !== undefined && { talabatChainId: talabatChainId || null }),
      ...(talabatWebhookSecret !== undefined && { talabatWebhookSecret: talabatWebhookSecret || null }),
      ...(clientWebhookUrl !== undefined && { clientWebhookUrl: clientWebhookUrl || null }),
      ...(clientWebhookSecret !== undefined && { clientWebhookSecret: clientWebhookSecret || null }),
    },
    include: { owner: { select: { id: true, name: true, email: true } } }
  });
  res.json(chain);
});

// Delete chain
router.delete('/:id', auth(['SUPER_ADMIN']), async (req, res) => {
  const chain = await prisma.chain.findUnique({ where: { id: req.params.id } });
  await prisma.chain.delete({ where: { id: req.params.id } });
  await prisma.user.delete({ where: { id: chain.ownerId } });
  res.json({ ok: true });
});

module.exports = router;

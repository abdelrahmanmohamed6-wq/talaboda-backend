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

// Get my chain (chain owner)
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

// Create chain + owner account (super admin only)
router.post('/', auth(['SUPER_ADMIN']), async (req, res) => {
  const { chainName, ownerName, ownerEmail, ownerPassword } = req.body;
  const hashed = await bcrypt.hash(ownerPassword, 10);

  const owner = await prisma.user.create({
    data: { name: ownerName, email: ownerEmail, password: hashed, role: 'CHAIN_OWNER' }
  });

  const chain = await prisma.chain.create({
    data: { name: chainName, ownerId: owner.id },
    include: { owner: { select: { id: true, name: true, email: true } } }
  });

  res.json(chain);
});

// Update chain name
router.patch('/:id', auth(['SUPER_ADMIN']), async (req, res) => {
  const chain = await prisma.chain.update({
    where: { id: req.params.id },
    data: { name: req.body.name }
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

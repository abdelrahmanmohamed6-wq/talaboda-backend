const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('Admin@1234', 10);
  const user = await prisma.user.upsert({
    where: { phone: '01000000000' },
    update: { password: hash, role: 'SUPER_ADMIN', isActive: true },
    create: { name: 'Super Admin', phone: '01000000000', password: hash, role: 'SUPER_ADMIN', isActive: true },
  });
  console.log('Admin ready:', user.phone, '| password: Admin@1234');
}

main().catch(console.error).finally(() => prisma.$disconnect());

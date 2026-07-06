import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

import { PrismaClient } from '../src/generated/prisma/client';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

async function main() {
  const senhaHash = await bcrypt.hash('1234', 10);

  await prisma.usuario.createMany({
    data: [
      { nome: 'Administrador', login: 'admin', senhaHash, role: 'ADMIN' },
      { nome: 'João Silva', login: 'joao', senhaHash, role: 'OPERADOR' },
      { nome: 'Maria Souza', login: 'maria', senhaHash, role: 'OPERADOR' },
    ],
    skipDuplicates: true,
  });

  // eslint-disable-next-line no-console
  console.log('Usuários de exemplo criados (login: admin, joao ou maria — senha: 1234).');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());

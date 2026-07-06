import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';
import { env } from './env';

// Prisma 7 usa "driver adapters": o client não fala com o Postgres através
// de um binário próprio, e sim de uma lib de driver JS (aqui, `pg`). Uma
// única instância é reaproveitada em toda a aplicação (evita esgotar
// conexões do Postgres ao criar um client por requisição).
const adapter = new PrismaPg({ connectionString: env.databaseUrl });

export const prisma = new PrismaClient({ adapter });

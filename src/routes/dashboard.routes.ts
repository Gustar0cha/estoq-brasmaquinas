import { Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import { getDashboardContagem } from '../services/dashboard.service';

export const dashboardRouter = Router();

const filtroSchema = z.object({
  modo: z.enum(['AO_VIVO', 'HISTORICO']).default('AO_VIVO'),
  dataInicio: z.coerce.date().optional(),
  dataFim: z.coerce.date().optional(),
  empresaCodigo: z.string().min(1).optional(),
});

dashboardRouter.get('/contagem', autenticar, exigirAdmin, async (req, res) => {
  const parse = filtroSchema.safeParse(req.query);
  if (!parse.success) {
    res.status(400).json({ erro: 'Filtro inválido para o dashboard.' });
    return;
  }

  res.json(await getDashboardContagem(parse.data));
});

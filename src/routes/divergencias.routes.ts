import { Router } from 'express';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as movimentacoesService from '../services/movimentacoes.service';

export const divergenciasRouter = Router();

divergenciasRouter.get('/', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await movimentacoesService.getDivergencias());
});

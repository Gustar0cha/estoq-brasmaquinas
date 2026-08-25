import { Router } from 'express';

import { autenticar, exigirAdmin } from '../middleware/auth';
import { getProdutosNegativados } from '../services/negativados.service';

export const negativadosRouter = Router();

negativadosRouter.get('/', autenticar, exigirAdmin, async (req, res) => {
  const { parceiro, grupo, empresa } = req.query;

  const produtos = await getProdutosNegativados({
    parceiro: typeof parceiro === 'string' ? parceiro : undefined,
    grupo: typeof grupo === 'string' ? grupo : undefined,
    empresa: typeof empresa === 'string' ? empresa : undefined,
  });
  res.json(produtos);
});

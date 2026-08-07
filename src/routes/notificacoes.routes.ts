import { Router } from 'express';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as notificacaoService from '../services/notificacao.service';

export const notificacoesRouter = Router();

notificacoesRouter.get('/', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await notificacaoService.getNotificacoes());
});

notificacoesRouter.patch('/:id/lida', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  await notificacaoService.marcarNotificacaoLida(id);
  res.json({ ok: true });
});

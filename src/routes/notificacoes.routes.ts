import { Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as notificacaoService from '../services/notificacao.service';

export const notificacoesRouter = Router();

notificacoesRouter.get('/', autenticar, async (req, res) => {
  res.json(await notificacaoService.getNotificacoes(req.usuario!.sub, req.usuario!.role === 'ADMIN'));
});

notificacoesRouter.patch('/:id/lida', autenticar, async (req, res) => {
  const { id } = req.params as { id: string };
  await notificacaoService.marcarNotificacaoLida(id);
  res.json({ ok: true });
});

notificacoesRouter.get('/preferencias', autenticar, exigirAdmin, async (_req, res) => {
  res.json({
    tipos: notificacaoService.TIPOS_NOTIFICACAO,
    preferencias: await notificacaoService.getPreferenciasNotificacao(),
  });
});

const preferenciaSchema = z.object({
  usuarioIds: z.array(z.string()),
});

notificacoesRouter.put('/preferencias/:tipo', autenticar, exigirAdmin, async (req, res) => {
  const { tipo } = req.params as { tipo: string };
  const parse = preferenciaSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  await notificacaoService.definirPreferenciaNotificacao(tipo, parse.data.usuarioIds);
  res.json({ ok: true });
});

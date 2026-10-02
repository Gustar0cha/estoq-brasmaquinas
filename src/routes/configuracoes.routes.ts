import { Router } from 'express';
import { z } from 'zod';

import { listarLogs } from '../lib/logAcao';
import { autenticar, exigirAdmin } from '../middleware/auth';
import { buscarLocais, ignorarLocais, listarLocaisIgnorados, reativarLocal } from '../services/contagemLivre.service';

// Configurações do painel: Logs e Locais ignorados. (A Equipe continua em
// /usuarios — só mudou de lugar na tela.)
export const configuracoesRouter = Router();

configuracoesRouter.use(autenticar, exigirAdmin);

configuracoesRouter.get('/logs', async (req, res) => {
  const q = req.query;
  const data = (v: unknown) => {
    if (typeof v !== 'string' || !v) return undefined;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  res.json(
    await listarLogs({
      usuarioId: typeof q.usuarioId === 'string' && q.usuarioId ? q.usuarioId : undefined,
      acoes: typeof q.acoes === 'string' && q.acoes ? q.acoes.split(',') : undefined,
      de: data(q.de),
      ate: data(q.ate),
      busca: typeof q.busca === 'string' ? q.busca : undefined,
      pagina: typeof q.pagina === 'string' ? Number(q.pagina) || 1 : 1,
    })
  );
});

configuracoesRouter.get('/locais-ignorados', async (_req, res) => {
  res.json(await listarLocaisIgnorados());
});

configuracoesRouter.get('/locais', async (req, res) => {
  res.json(await buscarLocais(typeof req.query.busca === 'string' ? req.query.busca : ''));
});

const ignorarSchema = z.object({
  locais: z.array(z.object({ localCodigo: z.string().min(1).max(20), local: z.string().min(1).max(200) })).min(1).max(1000),
  motivo: z.string().max(200).optional(),
});

configuracoesRouter.post('/locais-ignorados', async (req, res) => {
  const parse = ignorarSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Escolha ao menos um local.' });
    return;
  }
  res.json(await ignorarLocais(parse.data.locais, req.usuario!.sub, parse.data.motivo));
});

configuracoesRouter.delete('/locais-ignorados/:codigo', async (req, res) => {
  await reativarLocal(String((req.params as Record<string, string>).codigo), req.usuario!.sub);
  res.status(204).end();
});

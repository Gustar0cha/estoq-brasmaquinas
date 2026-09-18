import { Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as cicloService from '../services/ciclo.service';

export const cicloRouter = Router();

cicloRouter.get('/', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await cicloService.getCiclos());
});

const abrirSchema = z.object({
  nome: z.string().optional(),
  observacao: z.string().optional(),
});

cicloRouter.post('/', autenticar, exigirAdmin, async (req, res) => {
  const parse = abrirSchema.safeParse(req.body ?? {});
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  try {
    const ciclo = await cicloService.abrirCiclo({ ...parse.data, abertoPorId: req.usuario!.sub });
    res.status(201).json(ciclo);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível abrir a contagem.' });
  }
});

cicloRouter.post('/:id/fechar', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };

  try {
    res.json(await cicloService.fecharCiclo(id, req.usuario!.sub));
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível fechar a contagem.' });
  }
});

const renomearSchema = z.object({ nome: z.string().min(1) });

cicloRouter.patch('/:id', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = renomearSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Informe um nome para a contagem.' });
    return;
  }

  try {
    res.json(await cicloService.renomearCiclo(id, parse.data.nome));
  } catch (error) {
    res
      .status(404)
      .json({ erro: error instanceof Error ? error.message : 'Contagem não encontrada.' });
  }
});

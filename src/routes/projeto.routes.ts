import { Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as projetoService from '../services/projeto.service';

export const projetoRouter = Router();

const nomeSchema = z.object({ nome: z.string().trim().min(1).max(120) });

// Projeto é só uma identificação de agrupamento; por isso a API não cria
// dados operacionais nele e não altera as tarefas ao apagá-lo.
projetoRouter.get('/', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await projetoService.getProjetos());
});

projetoRouter.post('/', autenticar, exigirAdmin, async (req, res) => {
  const parse = nomeSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Informe o nome do projeto.' });
    return;
  }
  res.status(201).json(await projetoService.criarProjeto(parse.data.nome));
});

projetoRouter.patch('/:id', autenticar, exigirAdmin, async (req, res) => {
  const parse = nomeSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Informe o nome do projeto.' });
    return;
  }
  try {
    res.json(await projetoService.renomearProjeto((req.params as { id: string }).id, parse.data.nome));
  } catch (error) {
    res.status(404).json({ erro: error instanceof Error ? error.message : 'Projeto não encontrado.' });
  }
});

projetoRouter.delete('/:id', autenticar, exigirAdmin, async (req, res) => {
  try {
    await projetoService.apagarProjeto((req.params as { id: string }).id);
    res.status(204).end();
  } catch (error) {
    res.status(404).json({ erro: error instanceof Error ? error.message : 'Projeto não encontrado.' });
  }
});

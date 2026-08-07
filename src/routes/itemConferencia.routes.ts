import { Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as itemConferenciaService from '../services/itemConferencia.service';
import { StatusConferencia } from '../services/movimentacoes.service';
import { TipoMovimentacaoSankhya } from '../sankhya/types';

export const itemConferenciaRouter = Router();

itemConferenciaRouter.get('/', autenticar, async (req, res) => {
  const { tipo, status, atribuidoPara } = req.query;

  const itens = await itemConferenciaService.getItensAgrupados({
    tipo: typeof tipo === 'string' ? (tipo as TipoMovimentacaoSankhya) : undefined,
    status: typeof status === 'string' ? (status as StatusConferencia) : undefined,
    atribuidoPara: typeof atribuidoPara === 'string' ? atribuidoPara : undefined,
  });

  res.json(itens);
});

// Precisam vir antes de "/:chave" para não serem confundidas com uma chave literal.
itemConferenciaRouter.get('/indicadores', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await itemConferenciaService.getIndicadoresItens());
});

itemConferenciaRouter.get('/divergencias', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await itemConferenciaService.getDivergenciasItens());
});

itemConferenciaRouter.get('/:chave', autenticar, async (req, res) => {
  const { chave } = req.params as { chave: string };

  const item = await itemConferenciaService.getItemAgrupado(chave);
  if (!item) {
    res.status(404).json({ erro: 'Item não encontrado.' });
    return;
  }
  res.json(item);
});

const conferenciaItemSchema = z.object({
  quantidadeConferida: z.number(),
  motivo: z.string().optional(),
  observacao: z.string().optional(),
});

itemConferenciaRouter.post('/:chave/conferencia', autenticar, async (req, res) => {
  const { chave } = req.params as { chave: string };
  const parse = conferenciaItemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const item = await itemConferenciaService.enviarConferenciaItem({
      chave,
      conferidoPorId: req.usuario!.sub,
      quantidadeConferida: parse.data.quantidadeConferida,
      motivo: parse.data.motivo,
      observacao: parse.data.observacao,
    });
    res.json({ ok: true, item });
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível enviar a conferência.' });
  }
});

const atribuicaoSchema = z.object({
  usuarioId: z.string().nullable(),
});

itemConferenciaRouter.patch('/atribuicao-em-massa', autenticar, exigirAdmin, async (req, res) => {
  const atribuicaoEmMassaSchema = z.object({
    chaves: z.array(z.string()).min(1),
    usuarioId: z.string().nullable(),
  });

  const parse = atribuicaoEmMassaSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  await itemConferenciaService.atribuirItensEmMassa(parse.data.chaves, parse.data.usuarioId);
  res.json({ ok: true });
});

itemConferenciaRouter.patch('/:chave/atribuicao', autenticar, exigirAdmin, async (req, res) => {
  const { chave } = req.params as { chave: string };
  const parse = atribuicaoSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  const item = await itemConferenciaService.atribuirItem(chave, parse.data.usuarioId);
  res.json(item);
});

const comentarioSchema = z.object({
  comentarioAdmin: z.string(),
});

itemConferenciaRouter.patch('/:chave/comentario', autenticar, exigirAdmin, async (req, res) => {
  const { chave } = req.params as { chave: string };
  const parse = comentarioSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  try {
    const item = await itemConferenciaService.comentarDivergenciaItem(chave, parse.data.comentarioAdmin);
    res.json(item);
  } catch (error) {
    res.status(404).json({ erro: error instanceof Error ? error.message : 'Não encontrada.' });
  }
});

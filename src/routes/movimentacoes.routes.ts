import { Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as movimentacoesService from '../services/movimentacoes.service';
import { StatusConferencia } from '../services/movimentacoes.service';
import { TipoMovimentacaoSankhya } from '../sankhya/types';

export const movimentacoesRouter = Router();

movimentacoesRouter.get('/', autenticar, async (req, res) => {
  const { tipo, status, atribuidoPara } = req.query;

  const movimentacoes = await movimentacoesService.getMovimentacoes({
    tipo: typeof tipo === 'string' ? (tipo as TipoMovimentacaoSankhya) : undefined,
    status: typeof status === 'string' ? (status as StatusConferencia) : undefined,
    atribuidoPara: typeof atribuidoPara === 'string' ? atribuidoPara : undefined,
  });

  res.json(movimentacoes);
});

// Precisa vir antes de "/:id" para não ser confundido com um id literal "indicadores".
movimentacoesRouter.get('/indicadores', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await movimentacoesService.getIndicadores());
});

movimentacoesRouter.get('/:id', autenticar, async (req, res) => {
  const { id } = req.params as { id: string };

  try {
    res.json(await movimentacoesService.getMovimentacao(id));
  } catch (error) {
    res.status(404).json({ erro: error instanceof Error ? error.message : 'Não encontrada.' });
  }
});

const itemConferidoSchema = z.object({
  itemId: z.string(),
  codigoProduto: z.string(),
  quantidadeEsperada: z.number(),
  quantidadeConferida: z.number().nullable(),
});

const divergenciaSchema = z.object({
  itemId: z.string(),
  codigoProduto: z.string(),
  descricao: z.string(),
  quantidadeEsperada: z.number(),
  quantidadeConferida: z.number(),
  diferenca: z.number(),
  motivo: z.string(),
  observacao: z.string().optional(),
});

const conferenciaSchema = z.object({
  itens: z.array(itemConferidoSchema),
  divergencias: z.array(divergenciaSchema),
});

movimentacoesRouter.post('/:id/conferencia', autenticar, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = conferenciaSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const movimentacao = await movimentacoesService.enviarConferencia({
      movimentacaoId: id,
      conferidoPorId: req.usuario!.sub,
      itens: parse.data.itens,
      divergencias: parse.data.divergencias,
    });
    res.json({ ok: true, movimentacao });
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível enviar a conferência.' });
  }
});

const atribuicaoSchema = z.object({
  usuarioId: z.string().nullable(),
});

movimentacoesRouter.patch('/:id/atribuicao', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = atribuicaoSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  const movimentacao = await movimentacoesService.atribuirMovimentacao(id, parse.data.usuarioId);
  res.json(movimentacao);
});

const atribuicaoEmMassaSchema = z.object({
  movimentacaoIds: z.array(z.string()).min(1),
  usuarioId: z.string().nullable(),
});

movimentacoesRouter.patch('/atribuicao-em-massa', autenticar, exigirAdmin, async (req, res) => {
  const parse = atribuicaoEmMassaSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  await movimentacoesService.atribuirMovimentacoesEmMassa(
    parse.data.movimentacaoIds,
    parse.data.usuarioId
  );
  res.json({ ok: true });
});

const comentarioSchema = z.object({
  comentarioAdmin: z.string(),
});

movimentacoesRouter.patch('/:id/divergencias/:itemId', autenticar, exigirAdmin, async (req, res) => {
  const { id, itemId } = req.params as { id: string; itemId: string };
  const parse = comentarioSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  try {
    const movimentacao = await movimentacoesService.comentarDivergencia(
      id,
      itemId,
      parse.data.comentarioAdmin
    );
    res.json(movimentacao);
  } catch (error) {
    res.status(404).json({ erro: error instanceof Error ? error.message : 'Não encontrada.' });
  }
});

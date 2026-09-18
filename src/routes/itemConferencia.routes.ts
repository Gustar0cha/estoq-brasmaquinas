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
  quantidadeConferida: z.coerce.number(),
  motivo: z.string().optional(),
  observacao: z.string().optional(),
  codigoLocalBipado: z.string().optional(),
  codigoProdutoBipado: z.string().optional(),
});

itemConferenciaRouter.post(
  '/:chave/conferencia',
  autenticar,
  async (req, res) => {
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
        codigoLocalBipado: parse.data.codigoLocalBipado,
        codigoProdutoBipado: parse.data.codigoProdutoBipado,
      });
      res.json({ ok: true, item });
    } catch (error) {
      res
        .status(400)
        .json({ erro: error instanceof Error ? error.message : 'Não foi possível enviar a conferência.' });
    }
  }
);

const solicitarSegundaContagemSchema = z.object({
  usuarioId: z.string().nullable(),
});

itemConferenciaRouter.post(
  '/:chave/solicitar-segunda-contagem',
  autenticar,
  exigirAdmin,
  async (req, res) => {
    const { chave } = req.params as { chave: string };
    const parse = solicitarSegundaContagemSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ erro: 'Corpo da requisição inválido.' });
      return;
    }

    const item = await itemConferenciaService.solicitarSegundaContagem(
      chave,
      req.usuario!.sub,
      parse.data.usuarioId
    );
    if (!item) {
      res.status(404).json({ erro: 'Item não encontrado.' });
      return;
    }
    res.json(item);
  }
);

// Apaga uma contagem já registrada — só admin. Apagar a 1ª contagem também
// apaga a 2ª e qualquer pedido de recontagem que dependesse dela (cascata
// feita no service), voltando o item pro estado PENDENTE.
itemConferenciaRouter.delete(
  '/:chave/contagem/:numeroContagem',
  autenticar,
  exigirAdmin,
  async (req, res) => {
    const { chave, numeroContagem } = req.params as { chave: string; numeroContagem: string };
    const numero = Number(numeroContagem);
    if (numero !== 1 && numero !== 2) {
      res.status(400).json({ erro: 'Número de contagem inválido.' });
      return;
    }

    const item = await itemConferenciaService.apagarContagemItem(chave, numero);
    if (!item) {
      res.status(404).json({ erro: 'Item não encontrado.' });
      return;
    }
    res.json(item);
  }
);

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

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import { getEmpresasSankhya } from '../sankhya/client';
import * as contagemService from '../services/contagem.service';
import { StatusConferencia } from '../services/movimentacoes.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

export const contagemRouter = Router();
export const contagemItensRouter = Router();

// ---- Sessões de contagem (/contagem) ----------------------------------

const iniciarContagemSchema = z.object({
  empresaCodigo: z.string().nullable().optional(),
});

contagemRouter.post('/', autenticar, exigirAdmin, async (req, res) => {
  const parse = iniciarContagemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  try {
    const contagem = await contagemService.iniciarContagem(parse.data.empresaCodigo ?? null, req.usuario!.sub);
    res.status(201).json(contagem);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível iniciar a contagem.' });
  }
});

contagemRouter.get('/', autenticar, async (_req, res) => {
  res.json(await contagemService.listarContagens());
});

// Precisa vir antes de "/:id" pra não ser confundida com um id literal.
contagemRouter.get('/empresas', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await getEmpresasSankhya());
});

contagemRouter.get('/:id', autenticar, async (req, res) => {
  const { id } = req.params as { id: string };
  const contagem = await contagemService.getContagem(id);
  if (!contagem) {
    res.status(404).json({ erro: 'Contagem não encontrada.' });
    return;
  }
  res.json(contagem);
});

// ---- Itens de contagem (/contagem-itens) -------------------------------

contagemItensRouter.get('/', autenticar, async (req, res) => {
  const { contagemId, status, atribuidoPara } = req.query;

  const itens = await contagemService.getContagemItens({
    contagemId: typeof contagemId === 'string' ? contagemId : undefined,
    status: typeof status === 'string' ? (status as StatusConferencia) : undefined,
    atribuidoPara: typeof atribuidoPara === 'string' ? atribuidoPara : undefined,
  });
  res.json(itens);
});

contagemItensRouter.get('/divergencias', autenticar, exigirAdmin, async (req, res) => {
  const { contagemId } = req.query;
  if (typeof contagemId !== 'string') {
    res.status(400).json({ erro: 'contagemId é obrigatório.' });
    return;
  }
  res.json(await contagemService.getDivergenciasContagem(contagemId));
});

contagemItensRouter.get('/:id', autenticar, async (req, res) => {
  const { id } = req.params as { id: string };
  const item = await contagemService.getContagemItem(id);
  if (!item) {
    res.status(404).json({ erro: 'Item não encontrado.' });
    return;
  }
  res.json(item);
});

const conferenciaContagemSchema = z.object({
  quantidadeConferida: z.coerce.number(),
  motivo: z.string().optional(),
  observacao: z.string().optional(),
  codigoLocalBipado: z.string().optional(),
  codigoProdutoBipado: z.string().optional(),
});

contagemItensRouter.post('/:id/conferencia', autenticar, upload.single('foto'), async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = conferenciaContagemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const item = await contagemService.enviarContagemItem({
      itemId: id,
      conferidoPorId: req.usuario!.sub,
      quantidadeConferida: parse.data.quantidadeConferida,
      motivo: parse.data.motivo,
      observacao: parse.data.observacao,
      codigoLocalBipado: parse.data.codigoLocalBipado,
      codigoProdutoBipado: parse.data.codigoProdutoBipado,
      foto: req.file ? { buffer: req.file.buffer, mimeType: req.file.mimetype } : undefined,
    });
    res.json({ ok: true, item });
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível enviar a contagem.' });
  }
});

const solicitarSegundaContagemSchema = z.object({
  usuarioId: z.string().nullable(),
});

contagemItensRouter.post('/:id/solicitar-segunda-contagem', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = solicitarSegundaContagemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  const item = await contagemService.solicitarSegundaContagemContagemItem(id, req.usuario!.sub, parse.data.usuarioId);
  if (!item) {
    res.status(404).json({ erro: 'Item não encontrado.' });
    return;
  }
  res.json(item);
});

contagemItensRouter.get('/:id/foto/:numeroContagem', autenticar, exigirAdmin, async (req, res) => {
  const { id, numeroContagem } = req.params as { id: string; numeroContagem: string };

  try {
    const stream = await contagemService.getFotoContagemItem(id, Number(numeroContagem));
    if (!stream) {
      res.status(404).json({ erro: 'Foto não encontrada.' });
      return;
    }
    res.setHeader('Content-Type', 'image/jpeg');
    stream.pipe(res);
  } catch {
    res.status(404).json({ erro: 'Foto não encontrada.' });
  }
});

const atribuicaoSchema = z.object({
  usuarioId: z.string().nullable(),
});

contagemItensRouter.patch('/atribuicao-em-massa', autenticar, exigirAdmin, async (req, res) => {
  const atribuicaoEmMassaSchema = z.object({
    ids: z.array(z.string()).min(1),
    usuarioId: z.string().nullable(),
  });

  const parse = atribuicaoEmMassaSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  await contagemService.atribuirContagemItensEmMassa(parse.data.ids, parse.data.usuarioId);
  res.json({ ok: true });
});

contagemItensRouter.patch('/:id/atribuicao', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = atribuicaoSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  const item = await contagemService.atribuirContagemItem(id, parse.data.usuarioId);
  res.json(item);
});

const comentarioSchema = z.object({
  comentarioAdmin: z.string(),
});

contagemItensRouter.patch('/:id/comentario', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = comentarioSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }

  try {
    const item = await contagemService.comentarDivergenciaContagemItem(id, parse.data.comentarioAdmin);
    res.json(item);
  } catch (error) {
    res.status(404).json({ erro: error instanceof Error ? error.message : 'Não encontrada.' });
  }
});

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as contagemService from '../services/contagem.service';
import { StatusContagemItem } from '../services/contagem.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

export const contagemRouter = Router();
export const contagemItensRouter = Router();

contagemRouter.get('/indicadores', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await contagemService.getIndicadoresContagem());
});

contagemRouter.get('/progresso-predios', autenticar, exigirAdmin, async (_req, res) => {
  res.json(await contagemService.getProgressoContagemPorPredio());
});

contagemRouter.get('/locais', autenticar, exigirAdmin, async (req, res) => {
  const { empresa } = req.query;
  res.json(await contagemService.getPrediosDisponiveis(typeof empresa === 'string' ? empresa : undefined));
});

const atribuirContagemSchema = z.object({
  rua: z.string().nullable(),
  predio: z.string().nullable(),
  empresaCodigo: z.string().min(1),
  atribuidoParaId: z.string().min(1),
});

contagemRouter.post('/atribuir', autenticar, exigirAdmin, async (req, res) => {
  const parse = atribuirContagemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const resultado = await contagemService.atribuirContagemPredio({
      ...parse.data,
      atribuidoPorId: req.usuario!.sub,
    });
    res.status(201).json(resultado);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível atribuir a contagem.' });
  }
});

// ---- Itens de contagem (/contagem-itens) -------------------------------

contagemItensRouter.get('/', autenticar, async (req, res) => {
  const { status, atribuidoPara, dataInicio, dataFim } = req.query;

  const itens = await contagemService.getContagemItens({
    status: typeof status === 'string' ? (status as StatusContagemItem) : undefined,
    atribuidoPara: typeof atribuidoPara === 'string' ? atribuidoPara : undefined,
    dataInicio: typeof dataInicio === 'string' ? new Date(dataInicio) : undefined,
    dataFim: typeof dataFim === 'string' ? new Date(dataFim) : undefined,
  });
  res.json(itens);
});

// Precisa vir antes de "/:id" pra não ser confundida com um id literal.
contagemItensRouter.get('/divergencias', autenticar, exigirAdmin, async (req, res) => {
  const { dataInicio, dataFim } = req.query;
  res.json(
    await contagemService.getDivergenciasContagem({
      dataInicio: typeof dataInicio === 'string' ? new Date(dataInicio) : undefined,
      dataFim: typeof dataFim === 'string' ? new Date(dataFim) : undefined,
    })
  );
});

const iniciarContagemItemSchema = z.object({
  codigoProdutoBipado: z.string().min(1),
  codigoLocalBipado: z.string().min(1),
});

// O item já existe (PENDENTE, atribuído pelo admin) — aqui o colaborador só
// confirma por bipe que está de fato no produto+local esperado.
contagemItensRouter.post('/:id/iniciar', autenticar, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = iniciarContagemItemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const item = await contagemService.iniciarContagemItem({
      itemId: id,
      usuarioId: req.usuario!.sub,
      codigoProdutoBipado: parse.data.codigoProdutoBipado,
      codigoLocalBipado: parse.data.codigoLocalBipado,
    });
    res.json(item);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível iniciar a contagem.' });
  }
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

contagemItensRouter.post('/:id/iniciar-segunda', autenticar, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = iniciarContagemItemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const item = await contagemService.iniciarSegundaContagemItem(
      id,
      req.usuario!.sub,
      parse.data.codigoProdutoBipado,
      parse.data.codigoLocalBipado
    );
    res.json(item);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível iniciar a recontagem.' });
  }
});

const conferenciaContagemSchema = z.object({
  quantidadeConferida: z.coerce.number(),
  motivo: z.string().optional(),
  observacao: z.string().optional(),
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
  usuarioId: z.string().min(1),
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

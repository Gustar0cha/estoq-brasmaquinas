import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { autenticar, exigirAdmin } from '../middleware/auth';
import * as contagemService from '../services/contagem.service';
import { StatusContagemItem } from '../services/contagem.service';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

export const contagemRouter = Router();
export const contagemItensRouter = Router();

// A loja de quem está pedindo decide o que ele enxerga (os locais das outras
// lojas somem da interface). Vem do banco, não do token: o token antigo dos
// aparelhos já instalados não tem esse campo, e trocar todo mundo de token só
// por causa disso não compensa.
async function filialDoRequisitante(usuarioId?: string): Promise<string | null> {
  if (!usuarioId) return null;
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    select: { filial: true },
  });
  return usuario?.filial ?? null;
}

contagemRouter.get('/indicadores', autenticar, exigirAdmin, async (req, res) => {
  const filial = await filialDoRequisitante(req.usuario?.sub);
  res.json(await contagemService.getIndicadoresContagem(filial));
});

contagemRouter.get('/progresso-predios', autenticar, exigirAdmin, async (req, res) => {
  const filial = await filialDoRequisitante(req.usuario?.sub);
  res.json(await contagemService.getProgressoContagemPorPredio(filial));
});

contagemRouter.get('/locais', autenticar, exigirAdmin, async (req, res) => {
  const { empresa } = req.query;
  const filial = await filialDoRequisitante(req.usuario?.sub);
  res.json(
    await contagemService.getPrediosDisponiveis(typeof empresa === 'string' ? empresa : undefined, filial)
  );
});

// Busca de produto por código/descrição — o colaborador usa pra dizer QUAL
// produto ele achou fora do lugar (o código de barras da embalagem é do
// fabricante, não resolve o produto no Sankhya).
contagemRouter.get('/produtos', autenticar, async (req, res) => {
  const { busca } = req.query;
  if (typeof busca !== 'string' || busca.trim().length < 2) {
    res.json([]);
    return;
  }
  res.json(await contagemService.buscarProdutos(busca));
});

const atribuirContagemSchema = z.object({
  rua: z.string().nullable(),
  predio: z.string().nullable(),
  filial: z.string().nullable().optional(),
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

const reatribuirContagemSchema = z.object({
  rua: z.string().nullable(),
  predio: z.string().nullable(),
  filial: z.string().nullable().optional(),
  empresaCodigo: z.string().min(1),
  // Opcional: repassa só os itens que estão com essa pessoa.
  deUsuarioId: z.string().nullable().optional(),
  paraUsuarioId: z.string().min(1),
});

// Tira a contagem de um operador e entrega pra outro na mesma ação.
contagemRouter.post('/reatribuir', autenticar, exigirAdmin, async (req, res) => {
  const parse = reatribuirContagemSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const resultado = await contagemService.reatribuirContagemPredio({
      ...parse.data,
      reatribuidoPorId: req.usuario!.sub,
    });
    res.json(resultado);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível repassar a contagem.' });
  }
});

const removerAtribuicaoSchema = z.object({
  rua: z.string().nullable(),
  predio: z.string().nullable(),
  filial: z.string().nullable().optional(),
  empresaCodigo: z.string().min(1),
  deUsuarioId: z.string().nullable().optional(),
  // Limpeza total: leva junto as contagens já registradas do prédio.
  incluirContados: z.boolean().optional(),
  // Só os locais fora do endereçamento atual (limpeza de atribuição órfã).
  somenteLegado: z.boolean().optional(),
});

contagemRouter.post('/remover-atribuicao', autenticar, exigirAdmin, async (req, res) => {
  const parse = removerAtribuicaoSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const resultado = await contagemService.removerAtribuicaoPredio({
      ...parse.data,
      removidoPorId: req.usuario!.sub,
    });
    res.json(resultado);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível remover a atribuição.' });
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
    filial: await filialDoRequisitante(req.usuario?.sub),
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
      filial: await filialDoRequisitante(req.usuario?.sub),
    })
  );
});

const itemForaDoLugarSchema = z.object({
  codigoProduto: z.string().min(1),
  codigoProdutoBipado: z.string().min(1),
  codigoLocalBipado: z.string().min(1),
});

// Produto achado numa prateleira que não é a dele: entra na contagem de quem
// achou e, se o ERP esperava o produto em outro endereço, já nasce marcado
// como divergência de local pro admin.
contagemItensRouter.post('/fora-do-lugar', autenticar, async (req, res) => {
  const parse = itemForaDoLugarSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const item = await contagemService.registrarItemForaDoLugar({
      ...parse.data,
      usuarioId: req.usuario!.sub,
    });
    res.status(201).json(item);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível registrar o item.' });
  }
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

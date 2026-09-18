import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as itemConferenciaService from '../services/itemConferencia.service';
import { StatusConferencia } from '../services/movimentacoes.service';
import { TipoMovimentacaoSankhya } from '../sankhya/types';

export const itemConferenciaRouter = Router();

// Guarda a foto em memória (nunca em disco no servidor) e repassa direto
// pro MinIO — 8MB cobre com folga uma foto de câmera de celular comprimida.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

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

// multipart/form-data — a foto (opcional) vem junto no mesmo request, campos
// não-arquivo chegam como string em req.body mesmo os numéricos.
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
  upload.single('foto'),
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
        foto: req.file ? { buffer: req.file.buffer, mimeType: req.file.mimetype } : undefined,
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

// Nunca expõe a URL do MinIO nem as credenciais — o app só recebe o binário
// da foto, e só admin pode pedir (o operador que tirou a foto não vê ela de
// volta em lugar nenhum).
itemConferenciaRouter.get(
  '/:chave/foto/:numeroContagem',
  autenticar,
  exigirAdmin,
  async (req, res) => {
    const { chave, numeroContagem } = req.params as { chave: string; numeroContagem: string };

    try {
      const stream = await itemConferenciaService.getFotoContagem(chave, Number(numeroContagem));
      if (!stream) {
        res.status(404).json({ erro: 'Foto não encontrada.' });
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      stream.pipe(res);
    } catch {
      res.status(404).json({ erro: 'Foto não encontrada.' });
    }
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

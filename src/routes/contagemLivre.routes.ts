import { Request, Response, Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as servico from '../services/contagemLivre.service';
import { ErroContagemLivre } from '../services/contagemLivre.service';

// Contagem livre — ver services/contagemLivre.service.ts.
//
// Foto em memória, nunca em disco, e direto pro MinIO privado: o mesmo
// caminho das contagens antigas.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

export const contagemLivreRouter = Router();

// O app decide o que fazer pelo `codigo`, não pelo texto: SESSAO_ABERTA vira
// "finalizar e abrir o novo?", JA_CONTADO vira aviso, e por aí vai.
function responderErro(res: Response, erro: unknown) {
  if (erro instanceof ErroContagemLivre) {
    const status =
      erro.codigo === 'NAO_ENCONTRADA' ? 404
      : erro.codigo === 'NAO_AUTORIZADO' ? 403
      : ['SESSAO_ABERTA', 'JA_CONTADO', 'EMPRESA_OCUPADA'].includes(erro.codigo) ? 409
      : 400;
    res.status(status).json({ erro: erro.message, codigo: erro.codigo, ...(erro.detalhes ?? {}) });
    return;
  }
  if (erro instanceof z.ZodError) {
    res.status(400).json({ erro: 'Dados inválidos.', detalhes: erro.flatten() });
    return;
  }
  console.error('[contagem-livre]', erro);
  res.status(500).json({ erro: erro instanceof Error ? erro.message : 'Não foi possível concluir. Tente de novo.' });
}

const rota =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (erro) {
      responderErro(res, erro);
    }
  };

const param = (req: Request, nome: string) => String((req.params as Record<string, string>)[nome]);
const usuarioId = (req: Request) => req.usuario!.sub;

// Multipart manda tudo como texto.
const booleano = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .optional()
  .transform((v) => v === true || v === 'true');

// ---- Colaborador ---------------------------------------------------------

contagemLivreRouter.get('/estado', autenticar, rota(async (req, res) => {
  res.json(await servico.estadoDoColaborador(usuarioId(req)));
}));

// O rótulo "Cópia Estoque Dia ..." que o painel mostra em toda página.
contagemLivreRouter.get('/em-uso', autenticar, rota(async (_req, res) => {
  res.json(await servico.copiasEmUso());
}));

contagemLivreRouter.get('/sessoes/:sessaoId', autenticar, rota(async (req, res) => {
  res.json(await servico.getSessao(usuarioId(req), param(req, 'sessaoId')));
}));

const conferirSchema = z.object({
  codigo: z.string().trim().max(80).optional(),
  codigoProduto: z.string().trim().max(20).optional(),
  confirmarForaDoLocal: booleano,
});

contagemLivreRouter.post('/sessoes/:sessaoId/produto', autenticar, rota(async (req, res) => {
  const dados = conferirSchema.parse(req.body);
  res.json(await servico.conferirProduto({ usuarioId: usuarioId(req), sessaoId: param(req, 'sessaoId'), ...dados }));
}));

const registrarSchema = z.object({
  codigoProduto: z.string().trim().min(1).max(20),
  quantidade: z.coerce.number(),
  codigoBipado: z.string().trim().max(80).optional(),
  iniciadoEm: z.string().max(40).optional(),
  confirmarForaDoLocal: booleano,
});

contagemLivreRouter.post('/sessoes/:sessaoId/registros', autenticar, upload.single('foto'), rota(async (req, res) => {
  const dados = registrarSchema.parse(req.body);
  const registro = await servico.registrar({
    usuarioId: usuarioId(req),
    sessaoId: param(req, 'sessaoId'),
    ...dados,
    foto: req.file ? { buffer: req.file.buffer, mimeType: req.file.mimetype } : undefined,
  });
  res.status(201).json(registro);
}));

contagemLivreRouter.post('/sessoes/:sessaoId/finalizar', autenticar, rota(async (req, res) => {
  res.json(await servico.finalizarLocal(usuarioId(req), param(req, 'sessaoId')));
}));

contagemLivreRouter.delete('/registros/:registroId', autenticar, rota(async (req, res) => {
  await servico.apagarRegistro(usuarioId(req), param(req, 'registroId'));
  res.status(204).end();
}));

// Nunca expõe o MinIO: o binário passa por aqui, e só pro gestor.
contagemLivreRouter.get('/registros/:registroId/foto', autenticar, exigirAdmin, rota(async (req, res) => {
  const stream = await servico.fotoDoRegistro(param(req, 'registroId'));
  if (!stream) {
    res.status(404).json({ erro: 'Foto não encontrada.' });
    return;
  }
  res.setHeader('Content-Type', 'image/jpeg');
  stream.pipe(res);
}));

// ---- Gestor --------------------------------------------------------------

contagemLivreRouter.get('/copias', autenticar, exigirAdmin, rota(async (_req, res) => {
  res.json(await servico.listarCopiasDisponiveis());
}));

contagemLivreRouter.get('/', autenticar, exigirAdmin, rota(async (_req, res) => {
  res.json(await servico.listarContagensLivres());
}));

const criarSchema = z.object({
  nome: z.string().trim().max(80).optional(),
  dataCopia: z.string(),
  empresas: z.array(z.string()).min(1),
  fotoObrigatoria: z.boolean().optional(),
  travaLocal: z.boolean().optional(),
  travaDuplicada: z.boolean().optional(),
});

contagemLivreRouter.post('/', autenticar, exigirAdmin, rota(async (req, res) => {
  const dados = criarSchema.parse(req.body);
  res.status(201).json(await servico.criarContagemLivre({ ...dados, usuarioId: usuarioId(req) }));
}));

const atualizarSchema = z.object({
  nome: z.string().trim().max(80).optional(),
  fotoObrigatoria: z.boolean().optional(),
  travaLocal: z.boolean().optional(),
  travaDuplicada: z.boolean().optional(),
});

contagemLivreRouter.patch('/:id', autenticar, exigirAdmin, rota(async (req, res) => {
  res.json(await servico.atualizarContagemLivre(param(req, 'id'), atualizarSchema.parse(req.body)));
}));

contagemLivreRouter.post('/:id/encerrar', autenticar, exigirAdmin, rota(async (req, res) => {
  res.json(await servico.encerrarContagemLivre(param(req, 'id')));
}));

contagemLivreRouter.post('/:id/preparar', autenticar, exigirAdmin, rota(async (req, res) => {
  res.json(await servico.tentarPrepararDeNovo(param(req, 'id')));
}));

contagemLivreRouter.delete('/:id', autenticar, exigirAdmin, rota(async (req, res) => {
  await servico.excluirContagemLivre(param(req, 'id'));
  res.status(204).end();
}));

contagemLivreRouter.get('/:id/relatorio', autenticar, exigirAdmin, rota(async (req, res) => {
  res.json(await servico.relatorioContagemLivre(param(req, 'id')));
}));

contagemLivreRouter.get('/:id/relatorio.xlsx', autenticar, exigirAdmin, rota(async (req, res) => {
  const { buffer, nomeArquivo } = await servico.gerarRelatorioXlsx(param(req, 'id'));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
  res.send(Buffer.from(buffer as ArrayBuffer));
}));

const itemSchema = z.object({
  codigoProduto: z.string().min(1),
  localCodigo: z.string().min(1),
  empresaCodigo: z.string().min(1),
});

contagemLivreRouter.post('/:id/recontagens', autenticar, exigirAdmin, rota(async (req, res) => {
  const dados = z
    .object({ itens: z.array(itemSchema).min(1).max(2000), atribuidaParaId: z.string().nullable().optional() })
    .parse(req.body);
  res.json(
    await servico.pedirRecontagem({
      contagemId: param(req, 'id'),
      itens: dados.itens,
      atribuidaParaId: dados.atribuidaParaId ?? null,
      solicitadaPorId: usuarioId(req),
    })
  );
}));

contagemLivreRouter.post('/:id/recontagens/cancelar', autenticar, exigirAdmin, rota(async (req, res) => {
  await servico.cancelarRecontagem({ contagemId: param(req, 'id'), ...itemSchema.parse(req.body) });
  res.status(204).end();
}));

// Por último: "/:id/locais" não pode engolir as rotas fixas acima.
const abrirSchema = z.object({
  codigoLocal: z.string().trim().min(1).max(30),
  numeroContagem: z.coerce.number().int().min(1).max(2).optional(),
  finalizarAberta: z.boolean().optional(),
});

contagemLivreRouter.post('/:id/locais', autenticar, rota(async (req, res) => {
  const dados = abrirSchema.parse(req.body);
  res.status(201).json(await servico.abrirLocal({ usuarioId: usuarioId(req), contagemId: param(req, 'id'), ...dados }));
}));

contagemLivreRouter.get('/:id/meus-registros', autenticar, rota(async (req, res) => {
  res.json(await servico.meusRegistros(usuarioId(req), param(req, 'id')));
}));

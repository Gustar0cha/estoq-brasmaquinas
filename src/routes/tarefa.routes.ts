import { Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import * as tarefaService from '../services/tarefa.service';
import * as tratamentoService from '../services/tratamentoMovDiaria.service';

// Mesma regra das outras rotas: a loja vem do banco, não do token — o token
// dos aparelhos já instalados não traz esse campo.
async function filialDoRequisitante(usuarioId?: string): Promise<string | null> {
  if (!usuarioId) return null;
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    select: { filial: true },
  });
  return usuario?.filial ?? null;
}

export const tarefaRouter = Router();

const tipoSchema = z.enum(['CONTAGEM', 'MOV_DIARIA']);

// A lista vale pro painel e pro app: o operador pede só as dele passando
// `minhas=true`, e nunca vê tarefa de outra pessoa.
tarefaRouter.get('/', autenticar, async (req, res) => {
  const { tipo, cicloId, status, minhas, projetoId } = req.query;
  const filial = await filialDoRequisitante(req.usuario?.sub);

  const tarefas = await tarefaService.getTarefas({
    tipo: typeof tipo === 'string' && tipoSchema.safeParse(tipo).success ? (tipo as tarefaService.TipoTarefa) : undefined,
    cicloId: typeof cicloId === 'string' && cicloId ? cicloId : undefined,
    status: status === 'ABERTA' || status === 'FECHADA' ? status : undefined,
    atribuidaPara: minhas === 'true' ? req.usuario!.sub : undefined,
    filial,
    projetoId: typeof projetoId === 'string' && projetoId ? projetoId : undefined,
  });
  res.json(tarefas);
});

const criarSchema = z.object({
  nome: z.string().trim().min(1).max(120),
  tipo: tipoSchema,
  responsaveisIds: z.array(z.string().min(1)).default([]),
  diaReferencia: z.string().optional(),
  observacao: z.string().trim().max(500).optional(),
  projetoId: z.string().min(1).optional(),
});

const projetoSchema = z.object({ projetoId: z.string().min(1).nullable() });

tarefaRouter.patch('/:id/projeto', autenticar, exigirAdmin, async (req, res) => {
  const parse = projetoSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Projeto inválido.' });
    return;
  }
  try {
    res.json(await tarefaService.definirProjeto((req.params as { id: string }).id, parse.data.projetoId));
  } catch (error) {
    res.status(400).json({ erro: error instanceof Error ? error.message : 'Não foi possível vincular o projeto.' });
  }
});

tarefaRouter.post('/', autenticar, exigirAdmin, async (req, res) => {
  const parse = criarSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const tarefa = await tarefaService.criarTarefa({
      ...parse.data,
      diaReferencia: parse.data.diaReferencia ? new Date(parse.data.diaReferencia) : undefined,
      criadaPorId: req.usuario!.sub,
    });
    res.status(201).json(tarefa);
  } catch (error) {
    res.status(400).json({ erro: error instanceof Error ? error.message : 'Não foi possível criar a tarefa.' });
  }
});

const responsaveisSchema = z.object({ responsaveisIds: z.array(z.string().min(1)) });

tarefaRouter.patch('/:id/responsaveis', autenticar, exigirAdmin, async (req, res) => {
  const parse = responsaveisSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.' });
    return;
  }
  try {
    res.json(await tarefaService.definirResponsaveis((req.params as { id: string }).id, parse.data.responsaveisIds));
  } catch (error) {
    res.status(400).json({ erro: error instanceof Error ? error.message : 'Não foi possível atribuir.' });
  }
});

const renomearSchema = z.object({ nome: z.string().trim().min(1).max(120) });

tarefaRouter.patch('/:id/nome', autenticar, exigirAdmin, async (req, res) => {
  const parse = renomearSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Informe o nome.' });
    return;
  }
  try {
    res.json(await tarefaService.renomearTarefa((req.params as { id: string }).id, parse.data.nome));
  } catch (error) {
    res.status(400).json({ erro: error instanceof Error ? error.message : 'Não foi possível renomear.' });
  }
});

tarefaRouter.post('/:id/fechar', autenticar, exigirAdmin, async (req, res) => {
  try {
    res.json(await tarefaService.fecharTarefa((req.params as { id: string }).id));
  } catch (error) {
    res.status(400).json({ erro: error instanceof Error ? error.message : 'Não foi possível fechar.' });
  }
});

tarefaRouter.post('/:id/reabrir', autenticar, exigirAdmin, async (req, res) => {
  try {
    res.json(await tarefaService.reabrirTarefa((req.params as { id: string }).id));
  } catch (error) {
    res.status(400).json({ erro: error instanceof Error ? error.message : 'Não foi possível reabrir.' });
  }
});

tarefaRouter.delete('/:id', autenticar, exigirAdmin, async (req, res) => {
  try {
    res.json(await tarefaService.apagarTarefa((req.params as { id: string }).id));
  } catch (error) {
    res.status(400).json({ erro: error instanceof Error ? error.message : 'Não foi possível apagar.' });
  }
});

// ---------------------------------------------------------------------------
// Tratamento da Mov. Diária: a apuração que o gestor faz depois da coleta
// ---------------------------------------------------------------------------

tarefaRouter.get('/:id/mov-diaria', autenticar, exigirAdmin, async (req, res) => {
  try {
    res.json(await tratamentoService.getTratamentoDaTarefa((req.params as { id: string }).id));
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível carregar a apuração.' });
  }
});

// Número = corrige aquele campo e marca como editado à mão.
// null   = desfaz a correção e volta ao que o Sankhya diz.
// ausente = não mexe naquele campo.
const tratamentoSchema = z.object({
  chave: z.string().min(1),
  precoTabela: z.number().nullable().optional(),
  quantidadeEntrada: z.number().nullable().optional(),
  quantidadeSaida: z.number().nullable().optional(),
  comentario: z.string().max(500).nullable().optional(),
});

tarefaRouter.patch('/:id/mov-diaria', autenticar, exigirAdmin, async (req, res) => {
  const parse = tratamentoSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    await tratamentoService.salvarTratamento({
      ...parse.data,
      tarefaId: (req.params as { id: string }).id,
      tratadoPorId: req.usuario!.sub,
    });
    res.json(await tratamentoService.getTratamentoDaTarefa((req.params as { id: string }).id));
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível salvar a apuração.' });
  }
});

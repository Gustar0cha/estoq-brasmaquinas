import { prisma } from '../lib/prisma';
import { ehFilial, prefixoDaFilial } from '../lib/filiais';
import { garantirCicloAberto } from './ciclo.service';

// A tarefa é a unidade de trabalho e o recorte dos dados.
//
// Antes, inventário e conferência de nota caíam no mesmo balaio: um relatório
// do dia 23 devolvia a contagem daquele dia somada às movimentações, sem como
// separar. Agora cada item nasce dentro de uma tarefa, a tarefa tem TIPO, e é
// por ela que relatório, dashboard e app recortam.

export type TipoTarefa = 'CONTAGEM' | 'MOV_DIARIA';

const ABERTOS_CONTAGEM = [
  'PENDENTE',
  'EM_ANDAMENTO',
  'AGUARDANDO_SEGUNDA_CONTAGEM',
  'SEGUNDA_EM_ANDAMENTO',
];

export interface TarefaDTO {
  id: string;
  nome: string;
  tipo: TipoTarefa;
  status: 'ABERTA' | 'FECHADA';
  cicloId: string | null;
  diaReferencia: string | null;
  criadaPorId: string;
  criadaEm: string;
  fechadaEm: string | null;
  observacao: string | null;
  projetoId: string | null;
  projetoNome: string | null;
  responsaveis: { usuarioId: string; nome: string }[];
  total: number;
  contados: number;
  divergentes: number;
  // De onde a tarefa fala: um endereço, quantos endereços, ou o dia das notas.
  escopo: string;
}

export interface FiltroTarefas {
  tipo?: TipoTarefa;
  cicloId?: string;
  status?: 'ABERTA' | 'FECHADA';
  atribuidaPara?: string;
  filial?: string | null;
  projetoId?: string;
}

function rotuloDoEscopo(locais: Set<string>): string {
  if (locais.size === 0) return '—';
  if (locais.size === 1) return [...locais][0];
  return `${locais.size} endereços`;
}

export async function getTarefas(filtro?: FiltroTarefas): Promise<TarefaDTO[]> {
  const tarefas = await prisma.tarefa.findMany({
    where: {
      ...(filtro?.tipo ? { tipo: filtro.tipo } : {}),
      ...(filtro?.cicloId ? { cicloId: filtro.cicloId } : {}),
      ...(filtro?.status ? { status: filtro.status } : {}),
      ...(filtro?.projetoId ? { projetoId: filtro.projetoId } : {}),
      ...(filtro?.atribuidaPara
        ? { responsaveis: { some: { usuarioId: filtro.atribuidaPara } } }
        : {}),
    },
    include: {
      projeto: { select: { id: true, nome: true } },
      responsaveis: { include: { usuario: { select: { id: true, nome: true } } } },
      contagemItens: { select: { status: true, rua: true, predio: true, localCodigo: true } },
      itemResultados: { select: { diferenca: true, localCodigo: true, local: true, chave: true } },
      // A Mov. Diária mede pelo que foi DISTRIBUÍDO, não pelo que já voltou
      // contado — ver o cálculo de `total` abaixo.
      itemAtribuicoes: { select: { chave: true, localCodigo: true } },
    },
    orderBy: { criadaEm: 'desc' },
  });

  const prefixo = ehFilial(filtro?.filial) ? prefixoDaFilial(filtro.filial) : null;

  return tarefas
    .map((t): TarefaDTO => {
      const itens = prefixo
        ? t.contagemItens.filter((i) => i.localCodigo.startsWith(prefixo))
        : t.contagemItens;
      const conferencias = prefixo
        ? t.itemResultados.filter((r) => r.localCodigo.startsWith(prefixo))
        : t.itemResultados;
      const distribuidos = prefixo
        ? t.itemAtribuicoes.filter((a) => a.localCodigo.startsWith(prefixo))
        : t.itemAtribuicoes;

      const locais = new Set<string>();
      itens.forEach((i) => {
        if (i.rua || i.predio) locais.add(`Rua ${i.rua ?? '?'} - Predio ${i.predio ?? '?'}`);
      });
      conferencias.forEach((c) => locais.add(c.local));

      const ehContagem = t.tipo === 'CONTAGEM';

      // Na Mov. Diária o total é o que foi DISTRIBUÍDO, não o que já voltou
      // contado.
      //
      // Contar pelos resultados dizia "0 de 0" numa tarefa recém-distribuída —
      // e, pior, o filtro por loja lá embaixo derruba tarefa com total 0, então
      // ela sumia da lista de quem ia fazê-la. Foi assim que "teste gustavo",
      // com 1 item distribuído pro Rone, nunca chegou nele.
      //
      // A união cobre o resultado que chegou sem atribuição (contagem avulsa
      // de um item que ninguém distribuiu).
      const chavesDaMov = new Set([
        ...distribuidos.map((a) => a.chave),
        ...conferencias.map((c) => c.chave),
      ]);

      const total = ehContagem ? itens.length : chavesDaMov.size;
      const contados = ehContagem
        ? itens.filter((i) => !ABERTOS_CONTAGEM.includes(i.status)).length
        : new Set(conferencias.map((c) => c.chave)).size;
      const divergentes = ehContagem
        ? itens.filter((i) => i.status === 'DIVERGENCIA' || i.status === 'DIVERGENCIA_LOCAL').length
        : conferencias.filter((c) => c.diferenca !== 0).length;

      return {
        id: t.id,
        nome: t.nome,
        tipo: t.tipo as TipoTarefa,
        status: t.status as 'ABERTA' | 'FECHADA',
        cicloId: t.cicloId,
        diaReferencia: t.diaReferencia?.toISOString() ?? null,
        criadaPorId: t.criadaPorId,
        criadaEm: t.criadaEm.toISOString(),
        fechadaEm: t.fechadaEm?.toISOString() ?? null,
        observacao: t.observacao,
        projetoId: t.projetoId,
        projetoNome: t.projeto?.nome ?? null,
        responsaveis: t.responsaveis.map((r) => ({ usuarioId: r.usuario.id, nome: r.usuario.nome })),
        total,
        contados,
        divergentes,
        // Atribuição guarda o código do local, não o nome dele: numa Mov.
        // Diária ainda sem contagem, o que dá pra dizer é quantos endereços.
        escopo:
          locais.size > 0
            ? rotuloDoEscopo(locais)
            : (() => {
                const quantos = new Set(distribuidos.map((a) => a.localCodigo)).size;
                return quantos > 0 ? `${quantos} endereço${quantos === 1 ? '' : 's'}` : '—';
              })(),
      };
    })
    // Quem é de uma loja não enxerga a tarefa que só tem endereço de outra.
    .filter((t) => !prefixo || t.total > 0);
}

export async function getTarefa(id: string): Promise<TarefaDTO | null> {
  const todas = await getTarefas();
  return todas.find((t) => t.id === id) ?? null;
}

export interface CriarTarefaInput {
  nome: string;
  tipo: TipoTarefa;
  responsaveisIds: string[];
  criadaPorId: string;
  diaReferencia?: Date;
  observacao?: string;
  projetoId?: string;
}

export async function criarTarefa(input: CriarTarefaInput): Promise<TarefaDTO> {
  const nome = input.nome.trim();
  if (!nome) throw new Error('Dê um nome à tarefa.');

  // Só a de contagem entra num inventário; a de movimentação diária é de um
  // dia, não de um inventário.
  const cicloId =
    input.tipo === 'CONTAGEM' ? (await garantirCicloAberto(input.criadaPorId)).id : null;

  const tarefa = await prisma.tarefa.create({
    data: {
      nome,
      tipo: input.tipo,
      cicloId,
      diaReferencia: input.tipo === 'MOV_DIARIA' ? (input.diaReferencia ?? new Date()) : null,
      criadaPorId: input.criadaPorId,
      observacao: input.observacao?.trim() || null,
      ...(input.projetoId ? { projetoId: input.projetoId } : {}),
      responsaveis: {
        create: [...new Set(input.responsaveisIds)].map((usuarioId) => ({ usuarioId })),
      },
    },
  });

  const dto = await getTarefa(tarefa.id);
  if (!dto) throw new Error('Falha ao recarregar a tarefa recém-criada.');
  return dto;
}

export async function definirProjeto(id: string, projetoId: string | null): Promise<TarefaDTO> {
  if (projetoId) {
    const projeto = await prisma.projeto.findUnique({ where: { id: projetoId }, select: { id: true } });
    if (!projeto) throw new Error('Projeto não encontrado.');
  }
  await prisma.tarefa.update({ where: { id }, data: { projetoId } });
  const tarefa = await getTarefa(id);
  if (!tarefa) throw new Error('Tarefa não encontrada.');
  return tarefa;
}

export async function definirResponsaveis(
  tarefaId: string,
  usuarioIds: string[]
): Promise<TarefaDTO> {
  const unicos = [...new Set(usuarioIds)];
  await prisma.tarefaResponsavel.deleteMany({
    where: { tarefaId, usuarioId: { notIn: unicos.length > 0 ? unicos : ['-'] } },
  });
  for (const usuarioId of unicos) {
    await prisma.tarefaResponsavel.upsert({
      where: { tarefaId_usuarioId: { tarefaId, usuarioId } },
      create: { tarefaId, usuarioId },
      update: {},
    });
  }
  const tarefa = await getTarefa(tarefaId);
  if (!tarefa) throw new Error('Tarefa não encontrada.');
  return tarefa;
}

export async function renomearTarefa(id: string, nome: string): Promise<TarefaDTO> {
  if (!nome.trim()) throw new Error('O nome não pode ficar vazio.');
  await prisma.tarefa.update({ where: { id }, data: { nome: nome.trim() } });
  const tarefa = await getTarefa(id);
  if (!tarefa) throw new Error('Tarefa não encontrada.');
  return tarefa;
}

// A operação combinou fechar a tarefa no mesmo dia em que ela abre: tarefa que
// atravessa o dia incorpora movimentação do dia seguinte, e aí o número deixa
// de descrever o que foi realmente contado.
export async function fecharTarefa(id: string): Promise<TarefaDTO> {
  await prisma.tarefa.update({
    where: { id },
    data: { status: 'FECHADA', fechadaEm: new Date() },
  });
  const tarefa = await getTarefa(id);
  if (!tarefa) throw new Error('Tarefa não encontrada.');
  return tarefa;
}

export async function reabrirTarefa(id: string): Promise<TarefaDTO> {
  await prisma.tarefa.update({ where: { id }, data: { status: 'ABERTA', fechadaEm: null } });
  const tarefa = await getTarefa(id);
  if (!tarefa) throw new Error('Tarefa não encontrada.');
  return tarefa;
}

export async function apagarTarefa(id: string): Promise<{ itensSoltos: number }> {
  // Os itens não somem junto: voltam a ficar sem tarefa, e o histórico de quem
  // contou o quê continua de pé.
  const contagem = await prisma.contagemItem.updateMany({
    where: { tarefaId: id },
    data: { tarefaId: null },
  });
  const conferencia = await prisma.itemConferenciaResultado.updateMany({
    where: { tarefaId: id },
    data: { tarefaId: null },
  });
  await prisma.itemAtribuicao.updateMany({ where: { tarefaId: id }, data: { tarefaId: null } });
  await prisma.tarefa.delete({ where: { id } });
  return { itensSoltos: contagem.count + conferencia.count };
}

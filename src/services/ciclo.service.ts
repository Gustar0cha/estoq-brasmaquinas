// Ciclo de contagem: o recorte que delimita "um inventário".
//
// Antes disso a contagem era uma tabela solta filtrada por data, e comparar
// dois inventários dependia de alguém lembrar as datas exatas de cada um.
// Com o ciclo, "a contagem de setembro" é uma coisa que existe e pode ser
// comparada com a anterior sem ambiguidade.

import { prisma } from '../lib/prisma';

export type StatusCiclo = 'ABERTO' | 'FECHADO';

export interface CicloDTO {
  id: string;
  nome: string;
  status: StatusCiclo;
  abertoEm: string;
  abertoPor: string | null;
  fechadoEm: string | null;
  fechadoPor: string | null;
  observacao: string | null;

  // Resumo do que está dentro, pra listar sem uma consulta por linha.
  totalItens: number;
  contados: number;
  divergencias: number;
  pendentes: number;
  percentualConcluido: number;
}

const STATUS_CONTADO = ['CONFERIDA', 'DIVERGENCIA', 'DIVERGENCIA_LOCAL'];
const STATUS_DIVERGENTE = ['DIVERGENCIA', 'DIVERGENCIA_LOCAL'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function montarDTO(ciclo: any, resumo: { total: number; contados: number; divergencias: number }): CicloDTO {
  return {
    id: ciclo.id,
    nome: ciclo.nome,
    status: ciclo.status as StatusCiclo,
    abertoEm: ciclo.abertoEm.toISOString(),
    abertoPor: ciclo.abertoPor?.nome ?? null,
    fechadoEm: ciclo.fechadoEm?.toISOString() ?? null,
    fechadoPor: ciclo.fechadoPor?.nome ?? null,
    observacao: ciclo.observacao ?? null,
    totalItens: resumo.total,
    contados: resumo.contados,
    divergencias: resumo.divergencias,
    pendentes: resumo.total - resumo.contados,
    percentualConcluido: resumo.total > 0 ? Math.round((resumo.contados / resumo.total) * 100) : 0,
  };
}

export async function getCiclos(): Promise<CicloDTO[]> {
  const ciclos = await prisma.cicloContagem.findMany({
    include: { abertoPor: true, fechadoPor: true },
    orderBy: { abertoEm: 'desc' },
  });

  // Uma agregação só pra todos os ciclos, em vez de uma consulta por ciclo.
  const contagens = await prisma.contagemItem.groupBy({
    by: ['cicloId', 'status'],
    _count: { _all: true },
  });

  const resumos = new Map<string, { total: number; contados: number; divergencias: number }>();
  for (const linha of contagens) {
    if (!linha.cicloId) continue;
    const atual = resumos.get(linha.cicloId) ?? { total: 0, contados: 0, divergencias: 0 };
    atual.total += linha._count._all;
    if (STATUS_CONTADO.includes(linha.status)) atual.contados += linha._count._all;
    if (STATUS_DIVERGENTE.includes(linha.status)) atual.divergencias += linha._count._all;
    resumos.set(linha.cicloId, atual);
  }

  return ciclos.map((ciclo) =>
    montarDTO(ciclo, resumos.get(ciclo.id) ?? { total: 0, contados: 0, divergencias: 0 })
  );
}

// O ciclo que está recebendo as atribuições agora. Null quando nenhum está
// aberto — quem atribui decide o que fazer nesse caso.
export async function getCicloAberto() {
  return prisma.cicloContagem.findFirst({
    where: { status: 'ABERTO' },
    orderBy: { abertoEm: 'desc' },
  });
}

function nomePadrao(): string {
  const agora = new Date();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  return `Contagem de ${mes}/${agora.getFullYear()}`;
}

// Garante que existe um ciclo aberto pra receber uma atribuição.
//
// Cria um sozinho em vez de recusar a atribuição: quem está distribuindo
// prédio no meio do inventário não deveria travar porque ninguém abriu o
// ciclo antes. O ciclo criado assim fica marcado na observação.
export async function garantirCicloAberto(usuarioId: string) {
  const aberto = await getCicloAberto();
  if (aberto) return aberto;

  return prisma.cicloContagem.create({
    data: {
      nome: nomePadrao(),
      status: 'ABERTO',
      abertoPorId: usuarioId,
      observacao: 'Aberto automaticamente na primeira atribuição.',
    },
  });
}

export async function abrirCiclo(input: {
  nome?: string;
  observacao?: string;
  abertoPorId: string;
}): Promise<CicloDTO> {
  const jaAberto = await getCicloAberto();
  if (jaAberto) {
    throw new Error(
      `A contagem "${jaAberto.nome}" ainda está aberta. Feche ela antes de abrir outra.`
    );
  }

  const ciclo = await prisma.cicloContagem.create({
    data: {
      nome: input.nome?.trim() || nomePadrao(),
      status: 'ABERTO',
      abertoPorId: input.abertoPorId,
      observacao: input.observacao?.trim() || null,
    },
    include: { abertoPor: true, fechadoPor: true },
  });

  return montarDTO(ciclo, { total: 0, contados: 0, divergencias: 0 });
}

export async function fecharCiclo(id: string, fechadoPorId: string): Promise<CicloDTO> {
  const ciclo = await prisma.cicloContagem.findUnique({ where: { id } });
  if (!ciclo) throw new Error('Contagem não encontrada.');
  if (ciclo.status === 'FECHADO') throw new Error('Essa contagem já está fechada.');

  // Fechar com item pendente é uma decisão, não um acidente: o que não foi
  // contado fica registrado como não contado, e o número de concluído do
  // relatório passa a refletir isso pra sempre.
  const pendentes = await prisma.contagemItem.count({
    where: { cicloId: id, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
  });

  const atualizado = await prisma.cicloContagem.update({
    where: { id },
    data: {
      status: 'FECHADO',
      fechadoEm: new Date(),
      fechadoPorId,
      observacao:
        pendentes > 0
          ? [ciclo.observacao, `Fechada com ${pendentes} item(ns) sem contar.`]
              .filter(Boolean)
              .join(' ')
          : ciclo.observacao,
    },
    include: { abertoPor: true, fechadoPor: true },
  });

  const contagens = await prisma.contagemItem.groupBy({
    by: ['status'],
    where: { cicloId: id },
    _count: { _all: true },
  });
  const resumo = { total: 0, contados: 0, divergencias: 0 };
  for (const linha of contagens) {
    resumo.total += linha._count._all;
    if (STATUS_CONTADO.includes(linha.status)) resumo.contados += linha._count._all;
    if (STATUS_DIVERGENTE.includes(linha.status)) resumo.divergencias += linha._count._all;
  }

  return montarDTO(atualizado, resumo);
}

export async function renomearCiclo(id: string, nome: string): Promise<CicloDTO> {
  if (!nome.trim()) throw new Error('Informe um nome para a contagem.');
  const ciclo = await prisma.cicloContagem.update({
    where: { id },
    data: { nome: nome.trim() },
    include: { abertoPor: true, fechadoPor: true },
  });

  const contagens = await prisma.contagemItem.groupBy({
    by: ['status'],
    where: { cicloId: id },
    _count: { _all: true },
  });
  const resumo = { total: 0, contados: 0, divergencias: 0 };
  for (const linha of contagens) {
    resumo.total += linha._count._all;
    if (STATUS_CONTADO.includes(linha.status)) resumo.contados += linha._count._all;
    if (STATUS_DIVERGENTE.includes(linha.status)) resumo.divergencias += linha._count._all;
  }

  return montarDTO(ciclo, resumo);
}

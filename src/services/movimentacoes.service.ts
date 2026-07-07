import { prisma } from '../lib/prisma';
import { getMovimentacaoSankhyaPorId, getMovimentacoesSankhya } from '../sankhya/client';
import { MovimentacaoSankhya, TipoMovimentacaoSankhya } from '../sankhya/types';
import type {
  Divergencia as DivergenciaPrisma,
  ItemConferido as ItemConferidoPrisma,
} from '../generated/prisma/client';

export type StatusConferencia = 'PENDENTE' | 'CONFERIDA' | 'DIVERGENCIA';

export interface ItemMovimentacaoDTO {
  id: string;
  codigoProduto: string;
  codigoBarras: string;
  descricao: string;
  unidade: string;
  local: string;
  quantidadeEsperada: number;
  quantidadeConferida: number | null;
}

export interface DivergenciaDTO {
  itemId: string;
  codigoProduto: string;
  descricao: string;
  quantidadeEsperada: number;
  quantidadeConferida: number;
  diferenca: number;
  motivo: string;
  observacao?: string;
  comentarioAdmin?: string;
}

export interface MovimentacaoDTO {
  id: string;
  numeroNota: string;
  tipo: TipoMovimentacaoSankhya;
  parceiro: string;
  dataMovimentacao: string;
  empresaCodigo: string;
  empresaNome: string;
  status: StatusConferencia;
  atribuidoPara: string | null;
  itens: ItemMovimentacaoDTO[];
  divergencias: DivergenciaDTO[];
}

export interface FiltroMovimentacoes {
  tipo?: TipoMovimentacaoSankhya;
  status?: StatusConferencia;
  atribuidoPara?: string;
}

export interface DivergenciaComContextoDTO extends DivergenciaDTO {
  movimentacaoId: string;
  numeroNota: string;
  tipo: TipoMovimentacaoSankhya;
  parceiro: string;
}

export interface IndicadoresDTO {
  totalMovimentacoes: number;
  totalEntradas: number;
  totalSaidas: number;
  pendentes: number;
  conferidas: number;
  comDivergencia: number;
  naoAtribuidas: number;
}

export interface ItemConferidoInput {
  itemId: string;
  codigoProduto: string;
  quantidadeEsperada: number;
  quantidadeConferida: number | null;
}

export interface EnviarConferenciaInput {
  movimentacaoId: string;
  conferidoPorId: string;
  itens: ItemConferidoInput[];
  divergencias: DivergenciaDTO[];
}

// Combina o dado "vivo" do Sankhya (nota, itens, quantidade esperada) com a
// camada de conferência guardada no nosso Postgres (quem está responsável,
// o que já foi contado e quais divergências foram registradas).
async function montarMovimentacao(sankhya: MovimentacaoSankhya): Promise<MovimentacaoDTO> {
  const [atribuicao, conferencia] = await Promise.all([
    prisma.movimentacaoAtribuicao.findUnique({ where: { movimentacaoSankhyaId: sankhya.id } }),
    prisma.conferenciaResultado.findUnique({
      where: { movimentacaoSankhyaId: sankhya.id },
      include: { itens: true, divergencias: true },
    }),
  ]);

  const itens: ItemMovimentacaoDTO[] = sankhya.itens.map((item) => {
    const conferido = conferencia?.itens.find((i: ItemConferidoPrisma) => i.itemSankhyaId === item.id);
    return { ...item, quantidadeConferida: conferido?.quantidadeConferida ?? null };
  });

  const status: StatusConferencia = !conferencia
    ? 'PENDENTE'
    : conferencia.divergencias.length > 0
      ? 'DIVERGENCIA'
      : 'CONFERIDA';

  return {
    id: sankhya.id,
    numeroNota: sankhya.numeroNota,
    tipo: sankhya.tipo,
    parceiro: sankhya.parceiro,
    dataMovimentacao: sankhya.dataMovimentacao,
    empresaCodigo: sankhya.empresaCodigo,
    empresaNome: sankhya.empresaNome,
    status,
    atribuidoPara: atribuicao?.usuarioId ?? null,
    itens,
    divergencias: (conferencia?.divergencias ?? []).map((d: DivergenciaPrisma) => ({
      itemId: d.itemSankhyaId,
      codigoProduto: d.codigoProduto,
      descricao: d.descricao,
      quantidadeEsperada: d.quantidadeEsperada,
      quantidadeConferida: d.quantidadeConferida,
      diferenca: d.diferenca,
      motivo: d.motivo,
      observacao: d.observacao ?? undefined,
      comentarioAdmin: d.comentarioAdmin ?? undefined,
    })),
  };
}

export async function getMovimentacoes(filtro?: FiltroMovimentacoes): Promise<MovimentacaoDTO[]> {
  const sankhyaLista = await getMovimentacoesSankhya({ tipo: filtro?.tipo });
  const movimentacoes = await Promise.all(sankhyaLista.map(montarMovimentacao));

  return movimentacoes.filter((m) => {
    if (filtro?.status && m.status !== filtro.status) return false;
    if (filtro?.atribuidoPara && m.atribuidoPara !== filtro.atribuidoPara) return false;
    return true;
  });
}

export async function getMovimentacao(id: string): Promise<MovimentacaoDTO> {
  const sankhya = await getMovimentacaoSankhyaPorId(id);
  if (!sankhya) {
    throw new Error(`Movimentação ${id} não encontrada`);
  }
  return montarMovimentacao(sankhya);
}

export async function enviarConferencia(input: EnviarConferenciaInput): Promise<MovimentacaoDTO> {
  const sankhya = await getMovimentacaoSankhyaPorId(input.movimentacaoId);
  if (!sankhya) {
    throw new Error(`Movimentação ${input.movimentacaoId} não encontrada`);
  }

  const dadosItens = input.itens.map((item) => ({
    itemSankhyaId: item.itemId,
    codigoProduto: item.codigoProduto,
    quantidadeEsperada: item.quantidadeEsperada,
    quantidadeConferida: item.quantidadeConferida,
  }));

  const dadosDivergencias = input.divergencias.map((d) => ({
    itemSankhyaId: d.itemId,
    codigoProduto: d.codigoProduto,
    descricao: d.descricao,
    quantidadeEsperada: d.quantidadeEsperada,
    quantidadeConferida: d.quantidadeConferida,
    diferenca: d.diferenca,
    motivo: d.motivo,
    observacao: d.observacao,
  }));

  await prisma.conferenciaResultado.upsert({
    where: { movimentacaoSankhyaId: input.movimentacaoId },
    create: {
      movimentacaoSankhyaId: input.movimentacaoId,
      numeroNota: sankhya.numeroNota,
      tipo: sankhya.tipo,
      parceiro: sankhya.parceiro,
      conferidoPorId: input.conferidoPorId,
      dataConferencia: new Date(),
      itens: { create: dadosItens },
      divergencias: { create: dadosDivergencias },
    },
    update: {
      conferidoPorId: input.conferidoPorId,
      dataConferencia: new Date(),
      itens: { deleteMany: {}, create: dadosItens },
      divergencias: { deleteMany: {}, create: dadosDivergencias },
    },
  });

  return montarMovimentacao(sankhya);
}

export async function atribuirMovimentacao(
  movimentacaoId: string,
  usuarioId: string | null
): Promise<MovimentacaoDTO> {
  await prisma.movimentacaoAtribuicao.upsert({
    where: { movimentacaoSankhyaId: movimentacaoId },
    create: { movimentacaoSankhyaId: movimentacaoId, usuarioId },
    update: { usuarioId },
  });

  return getMovimentacao(movimentacaoId);
}

export async function atribuirMovimentacoesEmMassa(
  movimentacaoIds: string[],
  usuarioId: string | null
): Promise<void> {
  await Promise.all(
    movimentacaoIds.map((movimentacaoId) =>
      prisma.movimentacaoAtribuicao.upsert({
        where: { movimentacaoSankhyaId: movimentacaoId },
        create: { movimentacaoSankhyaId: movimentacaoId, usuarioId },
        update: { usuarioId },
      })
    )
  );
}

export async function comentarDivergencia(
  movimentacaoId: string,
  itemId: string,
  comentarioAdmin: string
): Promise<MovimentacaoDTO> {
  const conferencia = await prisma.conferenciaResultado.findUnique({
    where: { movimentacaoSankhyaId: movimentacaoId },
  });
  if (!conferencia) {
    throw new Error(`Conferência da movimentação ${movimentacaoId} não encontrada`);
  }

  await prisma.divergencia.updateMany({
    where: { conferenciaId: conferencia.id, itemSankhyaId: itemId },
    data: { comentarioAdmin },
  });

  return getMovimentacao(movimentacaoId);
}

interface DivergenciaComConferencia extends DivergenciaPrisma {
  conferencia: {
    movimentacaoSankhyaId: string;
    numeroNota: string;
    tipo: string;
    parceiro: string;
  };
}

export async function getDivergencias(): Promise<DivergenciaComContextoDTO[]> {
  const divergencias = await prisma.divergencia.findMany({ include: { conferencia: true } });

  return (divergencias as DivergenciaComConferencia[]).map((d) => ({
    itemId: d.itemSankhyaId,
    codigoProduto: d.codigoProduto,
    descricao: d.descricao,
    quantidadeEsperada: d.quantidadeEsperada,
    quantidadeConferida: d.quantidadeConferida,
    diferenca: d.diferenca,
    motivo: d.motivo,
    observacao: d.observacao ?? undefined,
    comentarioAdmin: d.comentarioAdmin ?? undefined,
    movimentacaoId: d.conferencia.movimentacaoSankhyaId,
    numeroNota: d.conferencia.numeroNota,
    tipo: d.conferencia.tipo as TipoMovimentacaoSankhya,
    parceiro: d.conferencia.parceiro,
  }));
}

export async function getIndicadores(): Promise<IndicadoresDTO> {
  const movimentacoes = await getMovimentacoes();

  return {
    totalMovimentacoes: movimentacoes.length,
    totalEntradas: movimentacoes.filter((m) => m.tipo === 'ENTRADA').length,
    totalSaidas: movimentacoes.filter((m) => m.tipo === 'SAIDA').length,
    pendentes: movimentacoes.filter((m) => m.status === 'PENDENTE').length,
    conferidas: movimentacoes.filter((m) => m.status === 'CONFERIDA').length,
    comDivergencia: movimentacoes.filter((m) => m.status === 'DIVERGENCIA').length,
    naoAtribuidas: movimentacoes.filter((m) => !m.atribuidoPara).length,
  };
}

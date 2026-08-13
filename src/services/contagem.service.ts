import { uploadFotoContagem, obterFotoStream } from '../lib/minio';
import { prisma } from '../lib/prisma';
import { getCopiaEstoqueSankhya } from '../sankhya/client';
import { calcularStatus } from './itemConferencia.service';
import { StatusConferencia } from './movimentacoes.service';

export type StatusContagemEstoque = 'EM_ANDAMENTO' | 'FINALIZADA';

export interface ContagemEstoqueDTO {
  id: string;
  numero: number;
  empresaCodigo: string | null;
  empresaNome: string | null;
  status: StatusContagemEstoque;
  iniciadaPorId: string;
  iniciadaEm: string;
  finalizadaEm: string | null;
  totalItens: number;
  pendentes: number;
  conferidos: number;
  comDivergencia: number;
  aguardandoSegundaContagem: number;
}

export interface ContagemItemDTO {
  id: string;
  contagemId: string;
  empresaCodigo: string;
  empresaNome: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  local: string;
  localCodigo: string;
  quantidadeEsperada: number;
  dataCopiaEstoque?: string;
  status: StatusConferencia;
  atribuidoPara: string | null;

  // 1ª contagem
  quantidadeConferida: number | null;
  diferenca: number | null;
  motivo?: string;
  observacao?: string;
  comentarioAdmin?: string;
  dataConferencia?: string;
  conferidoPorId?: string;
  codigoLocalBipado?: string;
  codigoProdutoBipado?: string;
  temFoto?: boolean;

  // 2ª contagem — só existe se foi solicitada pelo gestor
  segundaContagemSolicitada: boolean;
  segundaContagemAtribuidaPara?: string | null;
  quantidadeConferida2?: number;
  diferenca2?: number;
  motivo2?: string;
  observacao2?: string;
  dataConferencia2?: string;
  conferidoPor2Id?: string;
  codigoLocalBipado2?: string;
  codigoProdutoBipado2?: string;
  temFoto2?: boolean;
}

export interface EnviarContagemItemInput {
  itemId: string;
  conferidoPorId: string;
  quantidadeConferida: number;
  motivo?: string;
  observacao?: string;
  codigoLocalBipado?: string;
  codigoProdutoBipado?: string;
  foto?: { buffer: Buffer; mimeType: string };
}

export interface FiltroContagemItens {
  contagemId?: string;
  status?: StatusConferencia;
  atribuidoPara?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function montarContagemItemDTO(item: any): ContagemItemDTO {
  const contagem2Registrada = item.quantidadeConferida2 !== null;
  const atribuidoPara =
    item.segundaContagemSolicitada && !contagem2Registrada
      ? (item.segundaContagemUsuarioId ?? null)
      : (item.usuarioId ?? null);

  return {
    id: item.id,
    contagemId: item.contagemId,
    empresaCodigo: item.empresaCodigo,
    empresaNome: item.empresaNome,
    codigoProduto: item.codigoProduto,
    descricao: item.descricao,
    unidade: item.unidade,
    local: item.local,
    localCodigo: item.localCodigo,
    quantidadeEsperada: item.quantidadeEsperada,
    dataCopiaEstoque: item.dataCopiaEstoque?.toISOString(),
    status: item.status,
    atribuidoPara,

    quantidadeConferida: item.quantidadeConferida,
    diferenca: item.diferenca,
    motivo: item.motivo ?? undefined,
    observacao: item.observacao ?? undefined,
    comentarioAdmin: item.comentarioAdmin ?? undefined,
    dataConferencia: item.dataConferencia?.toISOString(),
    conferidoPorId: item.conferidoPorId ?? undefined,
    codigoLocalBipado: item.codigoLocalBipado ?? undefined,
    codigoProdutoBipado: item.codigoProdutoBipado ?? undefined,
    temFoto: Boolean(item.fotoChaveArmazenamento),

    segundaContagemSolicitada: item.segundaContagemSolicitada,
    segundaContagemAtribuidaPara: item.segundaContagemUsuarioId ?? null,
    quantidadeConferida2: item.quantidadeConferida2 ?? undefined,
    diferenca2: item.diferenca2 ?? undefined,
    motivo2: item.motivo2 ?? undefined,
    observacao2: item.observacao2 ?? undefined,
    dataConferencia2: item.dataConferencia2?.toISOString(),
    conferidoPor2Id: item.conferidoPor2Id ?? undefined,
    codigoLocalBipado2: item.codigoLocalBipado2 ?? undefined,
    codigoProdutoBipado2: item.codigoProdutoBipado2 ?? undefined,
    temFoto2: Boolean(item.fotoChaveArmazenamento2),
  };
}

async function calcularResumo(contagemId: string) {
  const grupos = await prisma.contagemItem.groupBy({
    by: ['status'],
    where: { contagemId },
    _count: { _all: true },
  });
  const mapa = Object.fromEntries(grupos.map((g) => [g.status, g._count._all]));

  return {
    totalItens: grupos.reduce((acc, g) => acc + g._count._all, 0),
    pendentes: mapa.PENDENTE ?? 0,
    conferidos: mapa.CONFERIDA ?? 0,
    comDivergencia: mapa.DIVERGENCIA ?? 0,
    aguardandoSegundaContagem: mapa.AGUARDANDO_SEGUNDA_CONTAGEM ?? 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function montarContagemEstoqueDTO(contagem: any, resumo: Awaited<ReturnType<typeof calcularResumo>>): ContagemEstoqueDTO {
  return {
    id: contagem.id,
    numero: contagem.numero,
    empresaCodigo: contagem.empresaCodigo,
    empresaNome: contagem.empresaNome,
    status: contagem.status,
    iniciadaPorId: contagem.iniciadaPorId,
    iniciadaEm: contagem.iniciadaEm.toISOString(),
    finalizadaEm: contagem.finalizadaEm?.toISOString() ?? null,
    ...resumo,
  };
}

// A cópia de estoque (TGFCTE) vira um retrato congelado no momento em que a
// contagem começa — os itens da sessão não mudam mais depois disso, mesmo
// que o estoque real do Sankhya continue se movendo enquanto a auditoria
// física está em andamento.
export async function iniciarContagem(
  empresaCodigo: string | null,
  iniciadaPorId: string
): Promise<ContagemEstoqueDTO> {
  const itensSankhya = await getCopiaEstoqueSankhya(empresaCodigo ?? undefined);
  if (itensSankhya.length === 0) {
    throw new Error('Nenhum item encontrado na cópia de estoque.');
  }

  // Defensivo: garante uma linha por produto+local mesmo se a cópia trouxer
  // alguma duplicata (a unique constraint da tabela não perdoaria).
  const porChave = new Map<string, (typeof itensSankhya)[number]>();
  for (const item of itensSankhya) {
    porChave.set(`${item.codigoProduto}|${item.localCodigo}`, item);
  }

  const empresaNome = empresaCodigo ? (itensSankhya[0]?.empresaNome ?? null) : null;

  const contagem = await prisma.contagemEstoque.create({
    data: { empresaCodigo, empresaNome, iniciadaPorId },
  });

  await prisma.contagemItem.createMany({
    data: Array.from(porChave.values()).map((item) => ({
      contagemId: contagem.id,
      empresaCodigo: item.empresaCodigo,
      empresaNome: item.empresaNome,
      codigoProduto: item.codigoProduto,
      descricao: item.descricao,
      unidade: item.unidade,
      local: item.local,
      localCodigo: item.localCodigo,
      quantidadeEsperada: item.quantidadeEsperada,
      dataCopiaEstoque: item.dataCopiaEstoque ? new Date(item.dataCopiaEstoque) : null,
    })),
  });

  const dto = await getContagem(contagem.id);
  if (!dto) throw new Error('Falha ao carregar a contagem recém-criada.');
  return dto;
}

export async function listarContagens(): Promise<ContagemEstoqueDTO[]> {
  const contagens = await prisma.contagemEstoque.findMany({ orderBy: { iniciadaEm: 'desc' } });
  return Promise.all(contagens.map(async (c) => montarContagemEstoqueDTO(c, await calcularResumo(c.id))));
}

export async function getContagem(id: string): Promise<ContagemEstoqueDTO | null> {
  const contagem = await prisma.contagemEstoque.findUnique({ where: { id } });
  if (!contagem) return null;
  return montarContagemEstoqueDTO(contagem, await calcularResumo(id));
}

export async function getContagemItens(filtro?: FiltroContagemItens): Promise<ContagemItemDTO[]> {
  const itens = await prisma.contagemItem.findMany({
    where: {
      ...(filtro?.contagemId ? { contagemId: filtro.contagemId } : {}),
      ...(filtro?.status ? { status: filtro.status } : {}),
    },
    orderBy: { descricao: 'asc' },
  });

  const dtos = itens.map(montarContagemItemDTO);
  return filtro?.atribuidoPara ? dtos.filter((i) => i.atribuidoPara === filtro.atribuidoPara) : dtos;
}

export async function getDivergenciasContagem(contagemId: string): Promise<ContagemItemDTO[]> {
  const [divergentes, aguardando] = await Promise.all([
    getContagemItens({ contagemId, status: 'DIVERGENCIA' }),
    getContagemItens({ contagemId, status: 'AGUARDANDO_SEGUNDA_CONTAGEM' }),
  ]);
  return [...divergentes, ...aguardando];
}

export async function getContagemItem(id: string): Promise<ContagemItemDTO | null> {
  const item = await prisma.contagemItem.findUnique({ where: { id } });
  return item ? montarContagemItemDTO(item) : null;
}

export async function atribuirContagemItem(id: string, usuarioId: string | null): Promise<ContagemItemDTO | null> {
  const item = await prisma.contagemItem.update({ where: { id }, data: { usuarioId } });
  return montarContagemItemDTO(item);
}

export async function atribuirContagemItensEmMassa(ids: string[], usuarioId: string | null): Promise<void> {
  await prisma.contagemItem.updateMany({ where: { id: { in: ids } }, data: { usuarioId } });
}

async function tentarFinalizarContagem(contagemId: string): Promise<void> {
  const pendentes = await prisma.contagemItem.count({
    where: { contagemId, status: { in: ['PENDENTE', 'AGUARDANDO_SEGUNDA_CONTAGEM'] } },
  });
  if (pendentes === 0) {
    await prisma.contagemEstoque.updateMany({
      where: { id: contagemId, status: 'EM_ANDAMENTO' },
      data: { status: 'FINALIZADA', finalizadaEm: new Date() },
    });
  }
}

export async function enviarContagemItem(input: EnviarContagemItemInput): Promise<ContagemItemDTO> {
  const item = await prisma.contagemItem.findUnique({ where: { id: input.itemId } });
  if (!item) {
    throw new Error(`Item de contagem ${input.itemId} não encontrado.`);
  }

  // Só é a 2ª contagem se a 1ª já divergiu e o gestor pediu recontagem —
  // senão é sempre a 1ª (reenviar sobrescreve, mesma regra da conferência
  // por movimentação).
  const ehSegundaContagem =
    item.quantidadeConferida !== null && item.diferenca !== 0 && item.segundaContagemSolicitada;
  const numeroContagem = ehSegundaContagem ? 2 : 1;

  const diferenca = input.quantidadeConferida - item.quantidadeEsperada;
  if (diferenca !== 0 && !input.motivo) {
    throw new Error('Motivo é obrigatório quando a contagem diverge do esperado.');
  }

  let fotoChave: string | undefined;
  if (input.foto) {
    fotoChave = await uploadFotoContagem(item.id, numeroContagem, input.foto.buffer, input.foto.mimeType);
  }

  const novoStatus = calcularStatus(
    { diferenca: numeroContagem === 1 ? diferenca : item.diferenca! },
    numeroContagem === 2 ? { diferenca } : item.quantidadeConferida2 !== null ? { diferenca: item.diferenca2! } : undefined,
    numeroContagem === 1 ? item.segundaContagemSolicitada : false
  );

  await prisma.contagemItem.update({
    where: { id: item.id },
    data:
      numeroContagem === 1
        ? {
            quantidadeConferida: input.quantidadeConferida,
            diferenca,
            motivo: diferenca !== 0 ? input.motivo : null,
            observacao: input.observacao ?? null,
            conferidoPorId: input.conferidoPorId,
            dataConferencia: new Date(),
            codigoLocalBipado: input.codigoLocalBipado ?? null,
            codigoProdutoBipado: input.codigoProdutoBipado ?? null,
            status: novoStatus,
            ...(fotoChave ? { fotoChaveArmazenamento: fotoChave } : {}),
          }
        : {
            quantidadeConferida2: input.quantidadeConferida,
            diferenca2: diferenca,
            motivo2: diferenca !== 0 ? input.motivo : null,
            observacao2: input.observacao ?? null,
            conferidoPor2Id: input.conferidoPorId,
            dataConferencia2: new Date(),
            codigoLocalBipado2: input.codigoLocalBipado ?? null,
            codigoProdutoBipado2: input.codigoProdutoBipado ?? null,
            segundaContagemSolicitada: false,
            status: novoStatus,
            ...(fotoChave ? { fotoChaveArmazenamento2: fotoChave } : {}),
          },
  });

  if (numeroContagem === 1 && diferenca !== 0) {
    await prisma.notificacao.create({
      data: {
        tipo: 'DIVERGENCIA_CONTAGEM',
        chave: item.id,
        titulo: 'Divergência na contagem de estoque',
        mensagem: `${item.descricao} (${item.local}): esperado ${item.quantidadeEsperada}, contado ${input.quantidadeConferida}.`,
      },
    });
  }

  await tentarFinalizarContagem(item.contagemId);

  const dto = await getContagemItem(item.id);
  if (!dto) throw new Error('Falha ao recarregar item de contagem.');
  return dto;
}

export async function comentarDivergenciaContagemItem(
  id: string,
  comentarioAdmin: string
): Promise<ContagemItemDTO | null> {
  const item = await prisma.contagemItem.update({ where: { id }, data: { comentarioAdmin } });
  return montarContagemItemDTO(item);
}

export async function solicitarSegundaContagemContagemItem(
  id: string,
  solicitadoPorId: string,
  usuarioId: string | null
): Promise<ContagemItemDTO | null> {
  const item = await prisma.contagemItem.update({
    where: { id },
    data: {
      segundaContagemSolicitada: true,
      segundaContagemSolicitadaPorId: solicitadoPorId,
      segundaContagemUsuarioId: usuarioId,
      status: 'AGUARDANDO_SEGUNDA_CONTAGEM',
    },
  });
  return montarContagemItemDTO(item);
}

export async function getFotoContagemItem(id: string, numeroContagem: number) {
  const item = await prisma.contagemItem.findUnique({ where: { id } });
  const chave = numeroContagem === 2 ? item?.fotoChaveArmazenamento2 : item?.fotoChaveArmazenamento;
  if (!chave) return null;
  return obterFotoStream(chave);
}

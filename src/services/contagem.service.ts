import { uploadFotoContagem, obterFotoStream } from '../lib/minio';
import { prisma } from '../lib/prisma';
import { getItemCopiaEstoque } from '../sankhya/client';

export type StatusContagemItem =
  | 'EM_ANDAMENTO'
  | 'CONFERIDA'
  | 'DIVERGENCIA'
  | 'AGUARDANDO_SEGUNDA_CONTAGEM'
  | 'SEGUNDA_EM_ANDAMENTO';

export interface ContagemItemDTO {
  id: string;
  empresaCodigo: string;
  empresaNome: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  local: string;
  localCodigo: string;
  quantidadeEsperada: number;
  dataCopiaEstoque?: string;
  status: StatusContagemItem;
  atribuidoPara: string | null;
  iniciadoPorId: string;
  iniciadoEm: string;

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
  segundaContagemIniciadaEm?: string;
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

export interface IniciarContagemItemInput {
  iniciadoPorId: string;
  codigoProdutoBipado: string;
  codigoLocalBipado: string;
}

export interface EnviarContagemItemInput {
  itemId: string;
  conferidoPorId: string;
  quantidadeConferida: number;
  motivo?: string;
  observacao?: string;
  foto?: { buffer: Buffer; mimeType: string };
}

export interface FiltroContagemItens {
  status?: StatusContagemItem;
  atribuidoPara?: string;
  dataInicio?: Date;
  dataFim?: Date;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function montarContagemItemDTO(item: any): ContagemItemDTO {
  const contagem2Registrada = item.quantidadeConferida2 !== null;
  // Enquanto ninguém terminou a 2ª contagem, quem deve ver o item na lista é
  // quem foi designado pra recontar — senão é quem começou a 1ª contagem (o
  // "dono" da contagem em aberto).
  const atribuidoPara =
    item.segundaContagemSolicitada && !contagem2Registrada
      ? (item.segundaContagemUsuarioId ?? null)
      : item.status === 'EM_ANDAMENTO'
        ? item.iniciadoPorId
        : null;

  return {
    id: item.id,
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
    iniciadoPorId: item.iniciadoPorId,
    iniciadoEm: item.iniciadoEm.toISOString(),

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
    segundaContagemIniciadaEm: item.segundaContagemIniciadaEm?.toISOString(),
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

async function nomeUsuario(usuarioId: string): Promise<string> {
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId } });
  return usuario?.nome ?? 'Alguém';
}

// O colaborador bipa produto+local por conta própria — sem admin atribuir
// nada antes. Busca a cópia de estoque ao vivo pra esse par específico; se
// não achar (local/produto inválido ou fora das regras de conferência),
// recusa aqui mesmo, antes de criar qualquer registro.
export async function iniciarContagemItem(input: IniciarContagemItemInput): Promise<ContagemItemDTO> {
  const encontrado = await getItemCopiaEstoque(input.codigoProdutoBipado, input.codigoLocalBipado);
  if (!encontrado) {
    throw new Error('Produto/local não encontrado na cópia de estoque atual.');
  }

  const item = await prisma.contagemItem.create({
    data: {
      empresaCodigo: encontrado.empresaCodigo,
      empresaNome: encontrado.empresaNome,
      codigoProduto: encontrado.codigoProduto,
      descricao: encontrado.descricao,
      unidade: encontrado.unidade,
      local: encontrado.local,
      localCodigo: encontrado.localCodigo,
      quantidadeEsperada: encontrado.quantidadeEsperada,
      dataCopiaEstoque: encontrado.dataCopiaEstoque ? new Date(encontrado.dataCopiaEstoque) : null,
      status: 'EM_ANDAMENTO',
      iniciadoPorId: input.iniciadoPorId,
      codigoProdutoBipado: input.codigoProdutoBipado,
      codigoLocalBipado: input.codigoLocalBipado,
    },
  });

  const nome = await nomeUsuario(input.iniciadoPorId);
  await prisma.notificacao.create({
    data: {
      tipo: 'INICIO_CONTAGEM',
      chave: item.id,
      titulo: 'Contagem iniciada',
      mensagem: `${nome} começou a contar ${item.descricao} (${item.local}).`,
    },
  });

  return montarContagemItemDTO(item);
}

// O gestor já escolheu quem faz a recontagem (solicitarSegundaContagemItem);
// aqui é o colaborador designado bipando de novo pra confirmar fisicamente
// que foi até o local antes de poder enviar a 2ª contagem.
export async function iniciarSegundaContagemItem(
  itemId: string,
  usuarioId: string,
  codigoProdutoBipado: string,
  codigoLocalBipado: string
): Promise<ContagemItemDTO> {
  const item = await prisma.contagemItem.findUnique({ where: { id: itemId } });
  if (!item) {
    throw new Error('Item de contagem não encontrado.');
  }
  if (!item.segundaContagemSolicitada || item.segundaContagemUsuarioId !== usuarioId) {
    throw new Error('Você não foi designado pra recontar esse item.');
  }
  if (item.quantidadeConferida2 !== null) {
    throw new Error('A 2ª contagem desse item já foi registrada.');
  }

  const atualizado = await prisma.contagemItem.update({
    where: { id: itemId },
    data: {
      status: 'SEGUNDA_EM_ANDAMENTO',
      segundaContagemIniciadaEm: new Date(),
      codigoProdutoBipado2: codigoProdutoBipado,
      codigoLocalBipado2: codigoLocalBipado,
    },
  });

  const nome = await nomeUsuario(usuarioId);
  await prisma.notificacao.create({
    data: {
      tipo: 'INICIO_SEGUNDA_CONTAGEM',
      chave: item.id,
      titulo: 'Recontagem iniciada',
      mensagem: `${nome} começou a recontar ${item.descricao} (${item.local}).`,
    },
  });

  return montarContagemItemDTO(atualizado);
}

export async function getContagemItens(filtro?: FiltroContagemItens): Promise<ContagemItemDTO[]> {
  const itens = await prisma.contagemItem.findMany({
    where: {
      ...(filtro?.status ? { status: filtro.status } : {}),
      ...(filtro?.dataInicio || filtro?.dataFim
        ? {
            iniciadoEm: {
              ...(filtro?.dataInicio ? { gte: filtro.dataInicio } : {}),
              ...(filtro?.dataFim ? { lte: filtro.dataFim } : {}),
            },
          }
        : {}),
    },
    orderBy: { iniciadoEm: 'desc' },
  });

  const dtos = itens.map(montarContagemItemDTO);
  return filtro?.atribuidoPara ? dtos.filter((i) => i.atribuidoPara === filtro.atribuidoPara) : dtos;
}

export async function getDivergenciasContagem(filtro?: {
  dataInicio?: Date;
  dataFim?: Date;
}): Promise<ContagemItemDTO[]> {
  const [divergentes, aguardando, segundaEmAndamento] = await Promise.all([
    getContagemItens({ ...filtro, status: 'DIVERGENCIA' }),
    getContagemItens({ ...filtro, status: 'AGUARDANDO_SEGUNDA_CONTAGEM' }),
    getContagemItens({ ...filtro, status: 'SEGUNDA_EM_ANDAMENTO' }),
  ]);
  return [...divergentes, ...aguardando, ...segundaEmAndamento];
}

export async function getContagemItem(id: string): Promise<ContagemItemDTO | null> {
  const item = await prisma.contagemItem.findUnique({ where: { id } });
  return item ? montarContagemItemDTO(item) : null;
}

export async function enviarContagemItem(input: EnviarContagemItemInput): Promise<ContagemItemDTO> {
  const item = await prisma.contagemItem.findUnique({ where: { id: input.itemId } });
  if (!item) {
    throw new Error(`Item de contagem ${input.itemId} não encontrado.`);
  }

  const numeroContagem = item.status === 'SEGUNDA_EM_ANDAMENTO' ? 2 : 1;
  if (numeroContagem === 1 && item.status !== 'EM_ANDAMENTO') {
    throw new Error('Essa contagem já foi enviada.');
  }

  const diferenca = input.quantidadeConferida - item.quantidadeEsperada;
  if (diferenca !== 0 && !input.motivo) {
    throw new Error('Motivo é obrigatório quando a contagem diverge do esperado.');
  }

  let fotoChave: string | undefined;
  if (input.foto) {
    fotoChave = await uploadFotoContagem(item.id, numeroContagem, input.foto.buffer, input.foto.mimeType);
  }

  const novoStatus: StatusContagemItem = diferenca === 0 ? 'CONFERIDA' : 'DIVERGENCIA';

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
            segundaContagemSolicitada: false,
            status: novoStatus,
            ...(fotoChave ? { fotoChaveArmazenamento2: fotoChave } : {}),
          },
  });

  const nome = await nomeUsuario(input.conferidoPorId);
  const rotulo = numeroContagem === 1 ? '' : ' (2ª contagem)';
  if (diferenca === 0) {
    await prisma.notificacao.create({
      data: {
        tipo: 'FIM_CONTAGEM',
        chave: item.id,
        titulo: numeroContagem === 1 ? 'Contagem concluída' : 'Recontagem concluída',
        mensagem: `${nome} contou ${item.descricao} (${item.local})${rotulo}: bateu com a cópia de estoque.`,
      },
    });
  } else {
    await prisma.notificacao.create({
      data: {
        tipo: 'DIVERGENCIA_CONTAGEM',
        chave: item.id,
        titulo: numeroContagem === 1 ? 'Divergência na contagem de estoque' : 'Divergência na recontagem',
        mensagem: `${nome} contou ${item.descricao} (${item.local})${rotulo}: esperado ${item.quantidadeEsperada}, contado ${input.quantidadeConferida}.`,
      },
    });
  }

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
  usuarioId: string
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

export interface IndicadoresContagemDTO {
  emAndamento: number;
  conferidos: number;
  comDivergencia: number;
  aguardandoSegundaContagem: number;
  segundaEmAndamento: number;
}

export async function getIndicadoresContagem(): Promise<IndicadoresContagemDTO> {
  const grupos = await prisma.contagemItem.groupBy({ by: ['status'], _count: { _all: true } });
  const mapa = Object.fromEntries(grupos.map((g) => [g.status, g._count._all]));

  return {
    emAndamento: mapa.EM_ANDAMENTO ?? 0,
    conferidos: mapa.CONFERIDA ?? 0,
    comDivergencia: mapa.DIVERGENCIA ?? 0,
    aguardandoSegundaContagem: mapa.AGUARDANDO_SEGUNDA_CONTAGEM ?? 0,
    segundaEmAndamento: mapa.SEGUNDA_EM_ANDAMENTO ?? 0,
  };
}

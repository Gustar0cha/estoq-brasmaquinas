import { uploadFotoContagem, obterFotoStream } from '../lib/minio';
import { prisma } from '../lib/prisma';
import {
  getItensCopiaEstoquePorLocais,
  getLocaisComCopiaEstoque,
} from '../sankhya/client';
import { chavePredio, parsearLocalizacao } from '../sankhya/localizacao';
import { criarNotificacao, notificarUsuario } from './notificacao.service';

export type StatusContagemItem =
  | 'PENDENTE'
  | 'EM_ANDAMENTO'
  | 'CONFERIDA'
  | 'DIVERGENCIA'
  | 'AGUARDANDO_SEGUNDA_CONTAGEM'
  | 'SEGUNDA_EM_ANDAMENTO';

const STATUS_ABERTOS: StatusContagemItem[] = [
  'PENDENTE',
  'EM_ANDAMENTO',
  'AGUARDANDO_SEGUNDA_CONTAGEM',
  'SEGUNDA_EM_ANDAMENTO',
];

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
  rua: string | null;
  predio: string | null;
  atribuidoPara: string | null;
  atribuidoPorId?: string;
  atribuidoEm: string;
  iniciadoPorId?: string;
  iniciadoEm?: string;

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
  itemId: string;
  usuarioId: string;
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
  // quem foi designado pra recontar — senão é quem o admin atribuiu pra 1ª
  // contagem (o "dono" da contagem em aberto).
  const atribuidoPara =
    item.segundaContagemSolicitada && !contagem2Registrada
      ? (item.segundaContagemUsuarioId ?? null)
      : (item.atribuidoParaId ?? null);

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
    rua: item.rua ?? null,
    predio: item.predio ?? null,
    atribuidoPara,
    atribuidoPorId: item.atribuidoPorId ?? undefined,
    atribuidoEm: item.atribuidoEm.toISOString(),
    iniciadoPorId: item.iniciadoPorId ?? undefined,
    iniciadoEm: item.iniciadoEm?.toISOString(),

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

// ---------------------------------------------------------------------------
// Descoberta de prédios (a partir da cópia de estoque já gerada no Sankhya)
// ---------------------------------------------------------------------------

export interface PredioDisponivel {
  rua: string | null;
  predio: string | null;
  empresaCodigo: string;
  empresaNome: string;
  totalItens: number;
  totalLocais: number;
  locais: { localCodigo: string; local: string }[];
}

// Agrupa os locais que têm cópia de estoque (TGFCTE) por rua/prédio — é essa
// lista que o admin navega pra escolher o que atribuir. Locais sem rua/prédio
// reconhecível caem num grupo { rua: null, predio: null } ("Outros locais").
export async function getPrediosDisponiveis(empresa?: string): Promise<PredioDisponivel[]> {
  const locais = await getLocaisComCopiaEstoque(empresa);
  const grupos = new Map<string, PredioDisponivel>();

  for (const local of locais) {
    const { rua, predio } = parsearLocalizacao(local.local);
    const chave = `${local.empresaCodigo}|${chavePredio(rua, predio)}`;
    let grupo = grupos.get(chave);
    if (!grupo) {
      grupo = {
        rua,
        predio,
        empresaCodigo: local.empresaCodigo,
        empresaNome: local.empresaNome,
        totalItens: 0,
        totalLocais: 0,
        locais: [],
      };
      grupos.set(chave, grupo);
    }
    grupo.totalItens += local.totalItens;
    grupo.totalLocais += 1;
    grupo.locais.push({ localCodigo: local.localCodigo, local: local.local });
  }

  return Array.from(grupos.values()).sort((a, b) => {
    if (a.empresaCodigo !== b.empresaCodigo) return a.empresaCodigo.localeCompare(b.empresaCodigo);
    if (a.rua !== b.rua) return (a.rua ?? 'zzz').localeCompare(b.rua ?? 'zzz');
    return (a.predio ?? 'zzz').localeCompare(b.predio ?? 'zzz');
  });
}

// ---------------------------------------------------------------------------
// Atribuição (admin distribui um prédio inteiro pra um colaborador contar)
// ---------------------------------------------------------------------------

export interface AtribuirContagemPredioInput {
  rua: string | null;
  predio: string | null;
  empresaCodigo: string;
  atribuidoParaId: string;
  atribuidoPorId: string;
}

export async function atribuirContagemPredio(
  input: AtribuirContagemPredioInput
): Promise<{ criados: number }> {
  const predios = await getPrediosDisponiveis(input.empresaCodigo);
  const grupo = predios.find((p) => p.rua === input.rua && p.predio === input.predio);
  if (!grupo) {
    throw new Error('Não há cópia de estoque registrada pra esse prédio.');
  }

  const itensCopia = await getItensCopiaEstoquePorLocais(
    grupo.locais.map((l) => l.localCodigo),
    input.empresaCodigo
  );

  const existentes = await prisma.contagemItem.findMany({
    where: { empresaCodigo: input.empresaCodigo, status: { in: STATUS_ABERTOS } },
    select: { codigoProduto: true, localCodigo: true },
  });
  const chavesExistentes = new Set(existentes.map((e) => `${e.codigoProduto}|${e.localCodigo}`));
  const novos = itensCopia.filter((i) => !chavesExistentes.has(`${i.codigoProduto}|${i.localCodigo}`));

  if (novos.length === 0) {
    return { criados: 0 };
  }

  await prisma.contagemItem.createMany({
    data: novos.map((i) => ({
      empresaCodigo: i.empresaCodigo,
      empresaNome: i.empresaNome,
      codigoProduto: i.codigoProduto,
      descricao: i.descricao,
      unidade: i.unidade,
      local: i.local,
      localCodigo: i.localCodigo,
      quantidadeEsperada: i.quantidadeEsperada,
      dataCopiaEstoque: i.dataCopiaEstoque ? new Date(i.dataCopiaEstoque) : null,
      status: 'PENDENTE',
      rua: input.rua,
      predio: input.predio,
      atribuidoParaId: input.atribuidoParaId,
      atribuidoPorId: input.atribuidoPorId,
    })),
  });

  const nomeAdmin = await nomeUsuario(input.atribuidoPorId);
  const rotulo = `Rua ${input.rua ?? '?'} Prédio ${input.predio ?? '?'}`;
  await notificarUsuario(
    'ATRIBUICAO_CONTAGEM',
    `${input.empresaCodigo}|${chavePredio(input.rua, input.predio)}`,
    'Nova contagem atribuída',
    `${nomeAdmin} atribuiu ${rotulo} pra você contar (${novos.length} ite${novos.length === 1 ? 'm' : 'ns'}).`,
    input.atribuidoParaId
  );

  return { criados: novos.length };
}

// ---------------------------------------------------------------------------
// Bipe validado (colaborador confirma um item já atribuído)
// ---------------------------------------------------------------------------

// O item já existe (PENDENTE, atribuído pelo admin) — aqui só confirma, por
// bipe, que o colaborador está de fato na frente do produto+local esperado.
// Bloqueia sem exceção se o bipe não bater: normalmente indica etiqueta
// física desatualizada (produto com a etiqueta de outro local).
export async function iniciarContagemItem(input: IniciarContagemItemInput): Promise<ContagemItemDTO> {
  const item = await prisma.contagemItem.findUnique({ where: { id: input.itemId } });
  if (!item) {
    throw new Error('Item de contagem não encontrado.');
  }
  if (item.status !== 'PENDENTE' || item.atribuidoParaId !== input.usuarioId) {
    throw new Error('Esse item não está atribuído a você.');
  }
  if (input.codigoProdutoBipado !== item.codigoProduto || input.codigoLocalBipado !== item.localCodigo) {
    throw new Error(
      `Esse produto está cadastrado em ${item.local} — confira a etiqueta do produto/local antes de continuar.`
    );
  }

  const atualizado = await prisma.contagemItem.update({
    where: { id: item.id },
    data: {
      status: 'EM_ANDAMENTO',
      iniciadoPorId: input.usuarioId,
      iniciadoEm: new Date(),
      codigoProdutoBipado: input.codigoProdutoBipado,
      codigoLocalBipado: input.codigoLocalBipado,
    },
  });

  const nome = await nomeUsuario(input.usuarioId);
  await criarNotificacao(
    'INICIO_CONTAGEM',
    item.id,
    'Contagem iniciada',
    `${nome} começou a contar ${item.descricao} (${item.local}).`
  );

  return montarContagemItemDTO(atualizado);
}

// O gestor já escolheu quem faz a recontagem (solicitarSegundaContagemItem);
// aqui é o colaborador designado bipando de novo pra confirmar fisicamente
// que foi até o local antes de poder enviar a 2ª contagem — mesma validação
// de etiqueta que a 1ª contagem.
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
  if (codigoProdutoBipado !== item.codigoProduto || codigoLocalBipado !== item.localCodigo) {
    throw new Error(
      `Esse produto está cadastrado em ${item.local} — confira a etiqueta do produto/local antes de continuar.`
    );
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
  await criarNotificacao(
    'INICIO_SEGUNDA_CONTAGEM',
    item.id,
    'Recontagem iniciada',
    `${nome} começou a recontar ${item.descricao} (${item.local}).`
  );

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
    orderBy: { atribuidoEm: 'desc' },
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
    await criarNotificacao(
      'FIM_CONTAGEM',
      item.id,
      numeroContagem === 1 ? 'Contagem concluída' : 'Recontagem concluída',
      `${nome} contou ${item.descricao} (${item.local})${rotulo}: bateu com a cópia de estoque.`
    );
  } else {
    await criarNotificacao(
      'DIVERGENCIA_CONTAGEM',
      item.id,
      numeroContagem === 1 ? 'Divergência na contagem de estoque' : 'Divergência na recontagem',
      `${nome} contou ${item.descricao} (${item.local})${rotulo}: esperado ${item.quantidadeEsperada}, contado ${input.quantidadeConferida}.`
    );
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
  pendente: number;
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
    pendente: mapa.PENDENTE ?? 0,
    emAndamento: mapa.EM_ANDAMENTO ?? 0,
    conferidos: mapa.CONFERIDA ?? 0,
    comDivergencia: mapa.DIVERGENCIA ?? 0,
    aguardandoSegundaContagem: mapa.AGUARDANDO_SEGUNDA_CONTAGEM ?? 0,
    segundaEmAndamento: mapa.SEGUNDA_EM_ANDAMENTO ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Monitoramento em tempo real por prédio
// ---------------------------------------------------------------------------

export interface ProgressoPredioColaborador {
  usuarioId: string;
  nome: string;
  itensEmAberto: number;
}

export interface ProgressoPredio {
  rua: string | null;
  predio: string | null;
  empresaCodigo: string;
  empresaNome: string;
  total: number;
  pendente: number;
  emAndamento: number;
  conferido: number;
  divergente: number;
  colaboradores: ProgressoPredioColaborador[];
}

export async function getProgressoContagemPorPredio(): Promise<ProgressoPredio[]> {
  const itens = await prisma.contagemItem.findMany({
    select: {
      rua: true,
      predio: true,
      empresaCodigo: true,
      empresaNome: true,
      status: true,
      atribuidoParaId: true,
      segundaContagemUsuarioId: true,
      segundaContagemSolicitada: true,
      quantidadeConferida2: true,
    },
  });

  const usuarioIds = new Set<string>();
  const grupos = new Map<string, ProgressoPredio>();

  for (const item of itens) {
    const chave = `${item.empresaCodigo}|${chavePredio(item.rua, item.predio)}`;
    let grupo = grupos.get(chave);
    if (!grupo) {
      grupo = {
        rua: item.rua,
        predio: item.predio,
        empresaCodigo: item.empresaCodigo,
        empresaNome: item.empresaNome,
        total: 0,
        pendente: 0,
        emAndamento: 0,
        conferido: 0,
        divergente: 0,
        colaboradores: [],
      };
      grupos.set(chave, grupo);
    }

    grupo.total += 1;
    if (item.status === 'PENDENTE') grupo.pendente += 1;
    if (item.status === 'EM_ANDAMENTO' || item.status === 'SEGUNDA_EM_ANDAMENTO') grupo.emAndamento += 1;
    if (item.status === 'CONFERIDA') grupo.conferido += 1;
    if (item.status === 'DIVERGENCIA' || item.status === 'AGUARDANDO_SEGUNDA_CONTAGEM') grupo.divergente += 1;

    const responsavel =
      item.segundaContagemSolicitada && item.quantidadeConferida2 === null
        ? item.segundaContagemUsuarioId
        : item.atribuidoParaId;
    if (responsavel && STATUS_ABERTOS.includes(item.status as StatusContagemItem)) {
      usuarioIds.add(responsavel);
    }
  }

  const usuarios = await prisma.usuario.findMany({ where: { id: { in: Array.from(usuarioIds) } } });
  const nomePorId = new Map(usuarios.map((u) => [u.id, u.nome]));

  // Segunda passada só pra montar a contagem de itens em aberto por colaborador.
  for (const [chave, grupo] of grupos) {
    const itensDoGrupo = itens.filter(
      (i) => `${i.empresaCodigo}|${chavePredio(i.rua, i.predio)}` === chave
    );
    const contagemPorUsuario = new Map<string, number>();
    for (const item of itensDoGrupo) {
      if (!STATUS_ABERTOS.includes(item.status as StatusContagemItem)) continue;
      const responsavel =
        item.segundaContagemSolicitada && item.quantidadeConferida2 === null
          ? item.segundaContagemUsuarioId
          : item.atribuidoParaId;
      if (!responsavel) continue;
      contagemPorUsuario.set(responsavel, (contagemPorUsuario.get(responsavel) ?? 0) + 1);
    }
    grupo.colaboradores = Array.from(contagemPorUsuario.entries()).map(([usuarioId, itensEmAberto]) => ({
      usuarioId,
      nome: nomePorId.get(usuarioId) ?? 'Alguém',
      itensEmAberto,
    }));
  }

  return Array.from(grupos.values()).sort((a, b) => {
    if (a.empresaCodigo !== b.empresaCodigo) return a.empresaCodigo.localeCompare(b.empresaCodigo);
    if (a.rua !== b.rua) return (a.rua ?? 'zzz').localeCompare(b.rua ?? 'zzz');
    return (a.predio ?? 'zzz').localeCompare(b.predio ?? 'zzz');
  });
}

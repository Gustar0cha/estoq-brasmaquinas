import { uploadFotoContagem, obterFotoStream, removerFotoContagem } from '../lib/minio';
import { prisma } from '../lib/prisma';
import { getMovimentacoesSankhya } from '../sankhya/client';
import { TipoMovimentacaoSankhya } from '../sankhya/types';
import { StatusConferencia } from './movimentacoes.service';

export interface NotaOrigemDTO {
  movimentacaoId: string;
  numeroNota: string;
  tipo: TipoMovimentacaoSankhya;
  parceiro: string;
  dataMovimentacao: string;
}

export interface ItemAgrupadoDTO {
  chave: string;
  empresaCodigo: string;
  empresaNome: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  local: string;
  localCodigo: string;
  quantidadeEsperada: number;
  status: StatusConferencia;
  atribuidoPara: string | null;
  notasOrigem: NotaOrigemDTO[];

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

export interface FiltroItensAgrupados {
  tipo?: TipoMovimentacaoSankhya;
  status?: StatusConferencia;
  atribuidoPara?: string;
}

export interface EnviarConferenciaItemInput {
  chave: string;
  conferidoPorId: string;
  quantidadeConferida: number;
  motivo?: string;
  observacao?: string;
  codigoLocalBipado?: string;
  codigoProdutoBipado?: string;
  foto?: { buffer: Buffer; mimeType: string };
}

function montarChave(empresaCodigo: string, codigoProduto: string, localCodigo: string): string {
  return `${empresaCodigo}|${codigoProduto}|${localCodigo}`;
}

// itemSankhyaId vem como "{nunota}-{codigoProduto}-{localCodigo}" (ver
// sankhya/client.ts) — mesma extração usada em movimentacoes.service.ts.
function extrairLocalCodigo(itemSankhyaId: string): string {
  return itemSankhyaId.split('-').pop()!;
}

interface GrupoAcumulado {
  chave: string;
  empresaCodigo: string;
  empresaNome: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  local: string;
  localCodigo: string;
  quantidadeEsperada: number;
  notasOrigem: NotaOrigemDTO[];
}

// Junta os itens de todas as notas do período num mapa por produto+local —
// o mesmo produto no mesmo local, vindo de notas diferentes, vira uma única
// linha (quantidadeEsperada já é compartilhada entre elas, ver client.ts).
async function agruparPorProdutoLocal(filtro?: { tipo?: TipoMovimentacaoSankhya }): Promise<Map<string, GrupoAcumulado>> {
  const movimentacoes = await getMovimentacoesSankhya({ tipo: filtro?.tipo });
  const grupos = new Map<string, GrupoAcumulado>();

  for (const mov of movimentacoes) {
    for (const item of mov.itens) {
      const localCodigo = extrairLocalCodigo(item.id);
      const chave = montarChave(mov.empresaCodigo, item.codigoProduto, localCodigo);

      let grupo = grupos.get(chave);
      if (!grupo) {
        grupo = {
          chave,
          empresaCodigo: mov.empresaCodigo,
          empresaNome: mov.empresaNome,
          codigoProduto: item.codigoProduto,
          descricao: item.descricao,
          unidade: item.unidade,
          local: item.local,
          localCodigo,
          quantidadeEsperada: item.quantidadeEsperada,
          notasOrigem: [],
        };
        grupos.set(chave, grupo);
      }

      grupo.notasOrigem.push({
        movimentacaoId: mov.id,
        numeroNota: mov.numeroNota,
        tipo: mov.tipo,
        parceiro: mov.parceiro,
        dataMovimentacao: mov.dataMovimentacao,
      });
    }
  }

  return grupos;
}

function calcularStatus(
  contagem1: { diferenca: number } | undefined,
  contagem2: { diferenca: number } | undefined,
  temSolicitacao: boolean
): StatusConferencia {
  if (!contagem1) return 'PENDENTE';
  if (contagem1.diferenca === 0) return 'CONFERIDA';
  if (contagem2) return contagem2.diferenca === 0 ? 'CONFERIDA' : 'DIVERGENCIA';
  if (temSolicitacao) return 'AGUARDANDO_SEGUNDA_CONTAGEM';
  return 'DIVERGENCIA';
}

async function montarDTOs(grupos: Map<string, GrupoAcumulado>): Promise<ItemAgrupadoDTO[]> {
  const chaves = Array.from(grupos.keys());

  const [atribuicoes, resultados, solicitacoes] = await Promise.all([
    prisma.itemAtribuicao.findMany({ where: { chave: { in: chaves } } }),
    prisma.itemConferenciaResultado.findMany({ where: { chave: { in: chaves } } }),
    prisma.itemSolicitacaoSegundaContagem.findMany({ where: { chave: { in: chaves } } }),
  ]);

  const atribuicaoPorChave = new Map(atribuicoes.map((a) => [a.chave, a]));
  const solicitacaoPorChave = new Map(solicitacoes.map((s) => [s.chave, s]));
  const resultado1PorChave = new Map(resultados.filter((r) => r.numeroContagem === 1).map((r) => [r.chave, r]));
  const resultado2PorChave = new Map(resultados.filter((r) => r.numeroContagem === 2).map((r) => [r.chave, r]));

  return Array.from(grupos.values()).map((grupo) => {
    const atribuicao = atribuicaoPorChave.get(grupo.chave);
    const solicitacao = solicitacaoPorChave.get(grupo.chave);
    const contagem1 = resultado1PorChave.get(grupo.chave);
    const contagem2 = resultado2PorChave.get(grupo.chave);

    const status = calcularStatus(contagem1, contagem2, Boolean(solicitacao));

    // Enquanto a 2ª contagem está pendente, quem deve ver o item na lista é
    // quem foi escolhido pra recontar — não mais o operador da 1ª contagem.
    const atribuidoPara =
      solicitacao && !contagem2 ? (solicitacao.usuarioId ?? null) : (atribuicao?.usuarioId ?? null);

    return {
      chave: grupo.chave,
      empresaCodigo: grupo.empresaCodigo,
      empresaNome: grupo.empresaNome,
      codigoProduto: grupo.codigoProduto,
      descricao: grupo.descricao,
      unidade: grupo.unidade,
      local: grupo.local,
      localCodigo: grupo.localCodigo,
      quantidadeEsperada: grupo.quantidadeEsperada,
      notasOrigem: grupo.notasOrigem,
      status,
      atribuidoPara,

      quantidadeConferida: contagem1?.quantidadeConferida ?? null,
      diferenca: contagem1?.diferenca ?? null,
      motivo: contagem1?.motivo ?? undefined,
      observacao: contagem1?.observacao ?? undefined,
      comentarioAdmin: contagem1?.comentarioAdmin ?? undefined,
      dataConferencia: contagem1?.dataConferencia?.toISOString(),
      conferidoPorId: contagem1?.conferidoPorId,
      codigoLocalBipado: contagem1?.codigoLocalBipado ?? undefined,
      codigoProdutoBipado: contagem1?.codigoProdutoBipado ?? undefined,
      temFoto: Boolean(contagem1?.fotoChaveArmazenamento),

      segundaContagemSolicitada: Boolean(solicitacao),
      segundaContagemAtribuidaPara: solicitacao?.usuarioId ?? null,
      quantidadeConferida2: contagem2?.quantidadeConferida ?? undefined,
      diferenca2: contagem2?.diferenca ?? undefined,
      motivo2: contagem2?.motivo ?? undefined,
      observacao2: contagem2?.observacao ?? undefined,
      dataConferencia2: contagem2?.dataConferencia?.toISOString(),
      conferidoPor2Id: contagem2?.conferidoPorId,
      codigoLocalBipado2: contagem2?.codigoLocalBipado ?? undefined,
      codigoProdutoBipado2: contagem2?.codigoProdutoBipado ?? undefined,
      temFoto2: Boolean(contagem2?.fotoChaveArmazenamento),
    };
  });
}

export async function getItensAgrupados(filtro?: FiltroItensAgrupados): Promise<ItemAgrupadoDTO[]> {
  const grupos = await agruparPorProdutoLocal({ tipo: filtro?.tipo });
  const itens = await montarDTOs(grupos);

  return itens.filter((item) => {
    if (filtro?.status && item.status !== filtro.status) return false;
    if (filtro?.atribuidoPara && item.atribuidoPara !== filtro.atribuidoPara) return false;
    return true;
  });
}

export async function getItemAgrupado(chave: string): Promise<ItemAgrupadoDTO | null> {
  const grupos = await agruparPorProdutoLocal();
  const grupo = grupos.get(chave);
  if (!grupo) return null;

  const [dto] = await montarDTOs(new Map([[chave, grupo]]));
  return dto;
}

export async function atribuirItem(chave: string, usuarioId: string | null): Promise<ItemAgrupadoDTO | null> {
  const [empresaCodigo, codigoProduto, localCodigo] = chave.split('|');

  await prisma.itemAtribuicao.upsert({
    where: { chave },
    create: { chave, empresaCodigo, codigoProduto, localCodigo, usuarioId },
    update: { usuarioId },
  });

  return getItemAgrupado(chave);
}

export async function atribuirItensEmMassa(chaves: string[], usuarioId: string | null): Promise<void> {
  await Promise.all(
    chaves.map((chave) => {
      const [empresaCodigo, codigoProduto, localCodigo] = chave.split('|');
      return prisma.itemAtribuicao.upsert({
        where: { chave },
        create: { chave, empresaCodigo, codigoProduto, localCodigo, usuarioId },
        update: { usuarioId },
      });
    })
  );
}

export async function enviarConferenciaItem(input: EnviarConferenciaItemInput): Promise<ItemAgrupadoDTO> {
  const grupos = await agruparPorProdutoLocal();
  const grupo = grupos.get(input.chave);
  if (!grupo) {
    throw new Error(`Grupo produto+local ${input.chave} não encontrado`);
  }

  const solicitacao = await prisma.itemSolicitacaoSegundaContagem.findUnique({
    where: { chave: input.chave },
  });
  const contagemExistente1 = await prisma.itemConferenciaResultado.findUnique({
    where: { chave_numeroContagem: { chave: input.chave, numeroContagem: 1 } },
  });
  // Se já existe 1ª contagem divergente com 2ª contagem solicitada, esse
  // envio é a 2ª contagem — senão é sempre a 1ª (reenviar sobrescreve).
  const numeroContagem = contagemExistente1 && contagemExistente1.diferenca !== 0 && solicitacao ? 2 : 1;

  const diferenca = input.quantidadeConferida - grupo.quantidadeEsperada;
  if (diferenca !== 0 && !input.motivo) {
    throw new Error('Motivo é obrigatório quando a contagem diverge do esperado.');
  }

  let fotoChaveArmazenamento: string | undefined;
  if (input.foto) {
    fotoChaveArmazenamento = await uploadFotoContagem(
      input.chave,
      numeroContagem,
      input.foto.buffer,
      input.foto.mimeType
    );
  }

  await prisma.itemConferenciaResultado.upsert({
    where: { chave_numeroContagem: { chave: input.chave, numeroContagem } },
    create: {
      chave: input.chave,
      numeroContagem,
      empresaCodigo: grupo.empresaCodigo,
      codigoProduto: grupo.codigoProduto,
      descricao: grupo.descricao,
      local: grupo.local,
      localCodigo: grupo.localCodigo,
      quantidadeEsperada: grupo.quantidadeEsperada,
      quantidadeConferida: input.quantidadeConferida,
      diferenca,
      conferidoPorId: input.conferidoPorId,
      dataConferencia: new Date(),
      motivo: diferenca !== 0 ? input.motivo : undefined,
      observacao: input.observacao,
      codigoLocalBipado: input.codigoLocalBipado,
      codigoProdutoBipado: input.codigoProdutoBipado,
      fotoChaveArmazenamento,
    },
    update: {
      quantidadeConferida: input.quantidadeConferida,
      diferenca,
      conferidoPorId: input.conferidoPorId,
      dataConferencia: new Date(),
      motivo: diferenca !== 0 ? input.motivo : null,
      observacao: input.observacao ?? null,
      codigoLocalBipado: input.codigoLocalBipado ?? null,
      codigoProdutoBipado: input.codigoProdutoBipado ?? null,
      ...(fotoChaveArmazenamento ? { fotoChaveArmazenamento } : {}),
    },
  });

  // 1ª contagem divergindo: avisa o gestor. 2ª contagem registrada: a
  // solicitação foi atendida, some da lista de "aguardando".
  if (numeroContagem === 1 && diferenca !== 0) {
    await prisma.notificacao.create({
      data: {
        tipo: 'DIVERGENCIA',
        chave: input.chave,
        titulo: 'Divergência na conferência',
        mensagem: `${grupo.descricao} (${grupo.local}): esperado ${grupo.quantidadeEsperada}, contado ${input.quantidadeConferida}.`,
      },
    });
  }
  if (numeroContagem === 2) {
    await prisma.itemSolicitacaoSegundaContagem.delete({ where: { chave: input.chave } }).catch(() => {});
  }

  const dto = await getItemAgrupado(input.chave);
  if (!dto) throw new Error('Falha ao recarregar item conferido.');
  return dto;
}

export async function comentarDivergenciaItem(
  chave: string,
  comentarioAdmin: string
): Promise<ItemAgrupadoDTO | null> {
  await prisma.itemConferenciaResultado.update({
    where: { chave_numeroContagem: { chave, numeroContagem: 1 } },
    data: { comentarioAdmin },
  });

  return getItemAgrupado(chave);
}

export async function solicitarSegundaContagem(
  chave: string,
  solicitadoPorId: string,
  usuarioId: string | null
): Promise<ItemAgrupadoDTO | null> {
  await prisma.itemSolicitacaoSegundaContagem.upsert({
    where: { chave },
    create: { chave, solicitadoPorId, usuarioId },
    update: { usuarioId },
  });

  return getItemAgrupado(chave);
}

// Apagar a 1ª contagem invalida qualquer 2ª contagem/pedido de recontagem que
// dependesse dela — o item volta pro estado "nunca conferido" (PENDENTE).
export async function apagarContagemItem(
  chave: string,
  numeroContagem: number
): Promise<ItemAgrupadoDTO | null> {
  const contagem = await prisma.itemConferenciaResultado.findUnique({
    where: { chave_numeroContagem: { chave, numeroContagem } },
  });
  if (!contagem) return getItemAgrupado(chave);

  if (contagem.fotoChaveArmazenamento) {
    await removerFotoContagem(contagem.fotoChaveArmazenamento).catch(() => {});
  }
  await prisma.itemConferenciaResultado.delete({
    where: { chave_numeroContagem: { chave, numeroContagem } },
  });

  if (numeroContagem === 1) {
    const contagem2 = await prisma.itemConferenciaResultado.findUnique({
      where: { chave_numeroContagem: { chave, numeroContagem: 2 } },
    });
    if (contagem2?.fotoChaveArmazenamento) {
      await removerFotoContagem(contagem2.fotoChaveArmazenamento).catch(() => {});
    }
    await prisma.itemConferenciaResultado.deleteMany({ where: { chave, numeroContagem: 2 } });
    await prisma.itemSolicitacaoSegundaContagem.delete({ where: { chave } }).catch(() => {});
  }

  return getItemAgrupado(chave);
}

export async function getFotoContagem(chave: string, numeroContagem: number) {
  const resultado = await prisma.itemConferenciaResultado.findUnique({
    where: { chave_numeroContagem: { chave, numeroContagem } },
  });
  if (!resultado?.fotoChaveArmazenamento) return null;
  return obterFotoStream(resultado.fotoChaveArmazenamento);
}

export interface IndicadoresDTO {
  totalMovimentacoes: number;
  totalEntradas: number;
  totalSaidas: number;
  pendentes: number;
  conferidas: number;
  comDivergencia: number;
  naoAtribuidas: number;
  aguardandoSegundaContagem: number;
}

export async function getIndicadoresItens(): Promise<IndicadoresDTO> {
  const itens = await getItensAgrupados();

  return {
    totalMovimentacoes: itens.length,
    totalEntradas: itens.filter((i) => i.notasOrigem.some((n) => n.tipo === 'ENTRADA')).length,
    totalSaidas: itens.filter((i) => i.notasOrigem.some((n) => n.tipo === 'SAIDA')).length,
    pendentes: itens.filter((i) => i.status === 'PENDENTE').length,
    conferidas: itens.filter((i) => i.status === 'CONFERIDA').length,
    comDivergencia: itens.filter((i) => i.status === 'DIVERGENCIA').length,
    naoAtribuidas: itens.filter((i) => !i.atribuidoPara).length,
    aguardandoSegundaContagem: itens.filter((i) => i.status === 'AGUARDANDO_SEGUNDA_CONTAGEM').length,
  };
}

export interface DivergenciaItemDTO {
  chave: string;
  codigoProduto: string;
  descricao: string;
  local: string;
  quantidadeEsperada: number;
  quantidadeConferida: number;
  diferenca: number;
  motivo: string;
  observacao?: string;
  comentarioAdmin?: string;
  temFoto?: boolean;
  segundaContagemSolicitada: boolean;
  segundaContagemAtribuidaPara?: string | null;
  quantidadeConferida2?: number;
  diferenca2?: number;
  motivo2?: string;
  temFoto2?: boolean;
  notasOrigem: NotaOrigemDTO[];
}

export async function getDivergenciasItens(): Promise<DivergenciaItemDTO[]> {
  const itens = await getItensAgrupados({ status: 'DIVERGENCIA' });
  const aguardando = await getItensAgrupados({ status: 'AGUARDANDO_SEGUNDA_CONTAGEM' });

  return [...itens, ...aguardando].map((item) => ({
    chave: item.chave,
    codigoProduto: item.codigoProduto,
    descricao: item.descricao,
    local: item.local,
    quantidadeEsperada: item.quantidadeEsperada,
    quantidadeConferida: item.quantidadeConferida!,
    diferenca: item.diferenca!,
    motivo: item.motivo ?? '',
    observacao: item.observacao,
    comentarioAdmin: item.comentarioAdmin,
    temFoto: item.temFoto,
    segundaContagemSolicitada: item.segundaContagemSolicitada,
    segundaContagemAtribuidaPara: item.segundaContagemAtribuidaPara,
    quantidadeConferida2: item.quantidadeConferida2,
    diferenca2: item.diferenca2,
    motivo2: item.motivo2,
    temFoto2: item.temFoto2,
    notasOrigem: item.notasOrigem,
  }));
}

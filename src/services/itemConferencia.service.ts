import { uploadFotoContagem, obterFotoStream, removerFotoContagem } from '../lib/minio';
import { prisma } from '../lib/prisma';
import { getMovimentacoesSankhya } from '../sankhya/client';
import { TipoMovimentacaoSankhya } from '../sankhya/types';
import { StatusConferencia } from './movimentacoes.service';
import { bipeIdentificaProduto } from './contagem.service';
import { criarNotificacao } from './notificacao.service';
import { parsearLocalizacao } from '../sankhya/localizacao';
import { DiaReferencia } from '../lib/datas';

export interface NotaOrigemDTO {
  movimentacaoId: string;
  numeroNota: string;
  tipo: TipoMovimentacaoSankhya;
  parceiro: string;
  dataMovimentacao: string;
  // Quanto ESTA nota movimentou do produto neste local. É o que permite ao
  // gestor somar entradas e saídas do período e explicar a diferença.
  quantidade: number;
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
  // Rua/prédio/nível lidos do nome do local, mesma regra da contagem. O app
  // agrupa a conferência em tarefas por prédio com isso, em vez de despejar
  // uma lista solta de produto+local.
  rua: string | null;
  predio: string | null;
  nivel: string | null;
  // Marca e grupo do Sankhya: a Mov. Diária ganhou os mesmos filtros das
  // Atribuições, e é por eles que o gestor recorta o lote.
  marca: string | null;
  grupoCodigo: string | null;
  grupo: string | null;
  // O saldo do local AGORA (TGFEST, lido a cada consulta). Muda sozinho
  // quando entra nota ou alguém ajusta o produto no Sankhya.
  quantidadeEsperada: number;
  status: StatusConferencia;
  atribuidoPara: string | null;
  // A tarefa de movimentação diária em que este item está. É o que separa a
  // conferência de hoje da de ontem no mesmo produto+local.
  tarefaId: string | null;
  notasOrigem: NotaOrigemDTO[];

  // 1ª contagem
  quantidadeConferida: number | null;
  // O saldo que o sistema dizia NA HORA em que a pessoa contou. É contra
  // este número que `diferenca` foi calculada — e não contra
  // `quantidadeEsperada`, que a essa altura já pode ter mudado. Sem ele a
  // tela mostrava "esperado 74, contado 74, diferença -34".
  quantidadeEsperadaNaContagem: number | null;
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
  quantidadeEsperadaNaContagem2?: number;
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
  tarefaId?: string;
  tipo?: TipoMovimentacaoSankhya;
  status?: StatusConferencia;
  atribuidoPara?: string;
}

export interface EnviarConferenciaItemInput {
  chave: string;
  // Em qual tarefa esta conferência está sendo feita. O app manda sempre; sem
  // ela, cai na atribuição que existir para o item.
  tarefaId?: string;
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
  rua: string | null;
  predio: string | null;
  nivel: string | null;
  marca: string | null;
  grupoCodigo: string | null;
  grupo: string | null;
  quantidadeEsperada: number;
  notasOrigem: NotaOrigemDTO[];
}

// Junta os itens de todas as notas do período num mapa por produto+local —
// o mesmo produto no mesmo local, vindo de notas diferentes, vira uma única
// linha (quantidadeEsperada já é compartilhada entre elas, ver client.ts).
export async function agruparPorProdutoLocal(filtro?: { tipo?: TipoMovimentacaoSankhya; diaReferencia?: DiaReferencia }): Promise<Map<string, GrupoAcumulado>> {
  const movimentacoes = await getMovimentacoesSankhya(filtro);
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
          ...parsearLocalizacao(item.local),
          marca: item.marca,
          grupoCodigo: item.grupoCodigo,
          grupo: item.grupo,
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
        quantidade: item.quantidadeMovimentada,
      });
    }
  }

  return grupos;
}

export function calcularStatus(
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

// `tarefaId` não é um filtro a mais: é o RECORTE da identidade do item.
//
// A chave é "empresa|produto|local" e não tem tarefa nem data. Sem recortar,
// a conferência feita na tarefa de ontem vinha colada no item da tarefa de
// hoje — o mesmo produto, dois trabalhos diferentes, um contaminando o outro.
// Com a tarefa em mãos, só o que nasceu nela conta.
export async function montarDTOs(
  grupos: Map<string, GrupoAcumulado>,
  tarefaId?: string
): Promise<ItemAgrupadoDTO[]> {
  const chaves = Array.from(grupos.keys());
  const daTarefa = tarefaId ? { tarefaId } : {};

  const [atribuicoes, resultados, solicitacoes] = await Promise.all([
    prisma.itemAtribuicao.findMany({ where: { chave: { in: chaves }, ...daTarefa } }),
    prisma.itemConferenciaResultado.findMany({ where: { chave: { in: chaves }, ...daTarefa } }),
    prisma.itemSolicitacaoSegundaContagem.findMany({ where: { chave: { in: chaves }, ...daTarefa } }),
  ]);

  // Sem tarefa pedida (a lista geral do gestor), o mesmo produto+local pode
  // ter linha em várias tarefas: vale a mais recente, que é o trabalho de
  // agora. Dentro de uma tarefa a lista já vem recortada e há no máximo uma.
  const maisRecente = <T extends { chave: string; criadoEm?: Date; dataConferencia?: Date; atualizadoEm?: Date }>(
    linhas: T[]
  ): Map<string, T> => {
    const mapa = new Map<string, T>();
    for (const linha of linhas) {
      const atual = mapa.get(linha.chave);
      const quando = (l: T) => (l.dataConferencia ?? l.atualizadoEm ?? l.criadoEm ?? new Date(0)).getTime();
      if (!atual || quando(linha) > quando(atual)) mapa.set(linha.chave, linha);
    }
    return mapa;
  };

  const atribuicaoPorChave = maisRecente(atribuicoes);
  const solicitacaoPorChave = maisRecente(solicitacoes);
  const resultado1PorChave = maisRecente(resultados.filter((r) => r.numeroContagem === 1));
  const resultado2PorChave = maisRecente(resultados.filter((r) => r.numeroContagem === 2));

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
      rua: grupo.rua,
      predio: grupo.predio,
      nivel: grupo.nivel,
      marca: grupo.marca,
      grupoCodigo: grupo.grupoCodigo,
      grupo: grupo.grupo,
      quantidadeEsperada: grupo.quantidadeEsperada,
      notasOrigem: grupo.notasOrigem,
      status,
      atribuidoPara,
      tarefaId: atribuicao?.tarefaId ?? contagem1?.tarefaId ?? null,

      quantidadeConferida: contagem1?.quantidadeConferida ?? null,
      quantidadeEsperadaNaContagem: contagem1?.quantidadeEsperada ?? null,
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
      quantidadeEsperadaNaContagem2: contagem2?.quantidadeEsperada ?? undefined,
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
  const itens = await montarDTOs(grupos, filtro?.tarefaId);

  return itens.filter((item) => {
    if (filtro?.status && item.status !== filtro.status) return false;
    if (filtro?.atribuidoPara && item.atribuidoPara !== filtro.atribuidoPara) return false;
    // Com a tarefa pedida, quem não é dela nem tem atribuição nela fica de
    // fora: o DTO já foi montado só com o que nasceu nesta tarefa.
    if (filtro?.tarefaId && item.tarefaId !== filtro.tarefaId) return false;
    return true;
  });
}

export async function getItemAgrupado(
  chave: string,
  tarefaId?: string
): Promise<ItemAgrupadoDTO | null> {
  const grupos = await agruparPorProdutoLocal();
  const grupo = grupos.get(chave);
  if (!grupo) return null;

  const [dto] = await montarDTOs(new Map([[chave, grupo]]), tarefaId);
  return dto;
}

// A chave única agora inclui a tarefa, e o campo é anulável. `findFirst` com
// `tarefaId` explícito evita a ambiguidade do Prisma com nulo dentro de chave
// composta — e deixa claro, lendo, que a busca é sempre dentro de uma tarefa.
async function acharAtribuicao(chave: string, tarefaId?: string) {
  return prisma.itemAtribuicao.findFirst({ where: { chave, tarefaId: tarefaId ?? null } });
}

async function acharResultado(chave: string, numeroContagem: number, tarefaId?: string) {
  return prisma.itemConferenciaResultado.findFirst({
    where: { chave, numeroContagem, tarefaId: tarefaId ?? null },
  });
}

async function acharSolicitacao(chave: string, tarefaId?: string) {
  return prisma.itemSolicitacaoSegundaContagem.findFirst({
    where: { chave, tarefaId: tarefaId ?? null },
  });
}

export async function atribuirItem(
  chave: string,
  usuarioId: string | null,
  tarefaId?: string
): Promise<ItemAgrupadoDTO | null> {
  const [empresaCodigo, codigoProduto, localCodigo] = chave.split('|');
  const existente = await acharAtribuicao(chave, tarefaId);

  if (existente) {
    await prisma.itemAtribuicao.update({ where: { id: existente.id }, data: { usuarioId } });
  } else {
    await prisma.itemAtribuicao.create({
      data: { chave, empresaCodigo, codigoProduto, localCodigo, usuarioId, tarefaId },
    });
  }

  return getItemAgrupado(chave, tarefaId);
}

export async function atribuirItensEmMassa(
  chaves: string[],
  usuarioId: string | null,
  tarefaId?: string
): Promise<void> {
  // Em série: em paralelo, duas chaves iguais na mesma leva corriam pra criar
  // a mesma linha e uma delas batia no índice único.
  for (const chave of chaves) {
    const [empresaCodigo, codigoProduto, localCodigo] = chave.split('|');
    const existente = await acharAtribuicao(chave, tarefaId);
    if (existente) {
      await prisma.itemAtribuicao.update({ where: { id: existente.id }, data: { usuarioId } });
    } else {
      await prisma.itemAtribuicao.create({
        data: { chave, empresaCodigo, codigoProduto, localCodigo, usuarioId, tarefaId },
      });
    }
  }
}

export async function enviarConferenciaItem(input: EnviarConferenciaItemInput): Promise<ItemAgrupadoDTO> {
  const grupos = await agruparPorProdutoLocal();
  const grupo = grupos.get(input.chave);
  if (!grupo) {
    throw new Error(`Grupo produto+local ${input.chave} não encontrado`);
  }
  // Só confere se houve bipe: item sem código de barras é contado pela lista.
  // E vale também o código aprendido no histórico — ver bipeIdentificaProduto.
  if (input.codigoProdutoBipado?.trim()) {
    const produtoValido = await bipeIdentificaProduto(input.codigoProdutoBipado, grupo.codigoProduto);
    if (!produtoValido) {
      throw new Error(
        `O código bipado não pertence a ${grupo.descricao}. Bipe o código desse produto, ou conte pela lista se ele não tiver código de barras.`
      );
    }
  }

  // A conferência nasce dentro da tarefa em que o item foi distribuído. Se o
  // app disse em qual tarefa está contando, é ela que manda: o mesmo
  // produto+local pode estar em tarefas diferentes, e escrever na errada
  // sobrescreveria a contagem de outro dia.
  const atribuicaoDoItem = await acharAtribuicao(input.chave, input.tarefaId);
  const tarefaDaConferencia = input.tarefaId ?? atribuicaoDoItem?.tarefaId ?? undefined;

  const solicitacao = await acharSolicitacao(input.chave, tarefaDaConferencia);
  const contagemExistente1 = await acharResultado(input.chave, 1, tarefaDaConferencia);
  // Se já existe 1ª contagem divergente com 2ª contagem solicitada, esse
  // envio é a 2ª contagem — senão é sempre a 1ª (reenviar sobrescreve).
  const numeroContagem = contagemExistente1 && contagemExistente1.diferenca !== 0 && solicitacao ? 2 : 1;

  const diferenca = input.quantidadeConferida - grupo.quantidadeEsperada;
  // Sem cobrar motivo de quem confere: exigi-lo fazia o app avisar que a
  // conferência tinha divergido, e a contagem tem que ser cega. O gestor
  // classifica depois, no painel.

  let fotoChaveArmazenamento: string | undefined;
  if (input.foto) {
    fotoChaveArmazenamento = await uploadFotoContagem(
      input.chave,
      numeroContagem,
      input.foto.buffer,
      input.foto.mimeType
    );
  }

  const existente = await acharResultado(input.chave, numeroContagem, tarefaDaConferencia);

  const dadosComuns = {
    quantidadeConferida: input.quantidadeConferida,
    diferenca,
    conferidoPorId: input.conferidoPorId,
    dataConferencia: new Date(),
  };

  if (existente) {
    await prisma.itemConferenciaResultado.update({
      where: { id: existente.id },
      data: {
        ...dadosComuns,
        motivo: diferenca !== 0 ? input.motivo : null,
        observacao: input.observacao ?? null,
        codigoLocalBipado: input.codigoLocalBipado ?? null,
        codigoProdutoBipado: input.codigoProdutoBipado ?? null,
        ...(fotoChaveArmazenamento ? { fotoChaveArmazenamento } : {}),
      },
    });
  } else {
    await prisma.itemConferenciaResultado.create({
      data: {
        ...dadosComuns,
        chave: input.chave,
        numeroContagem,
        empresaCodigo: grupo.empresaCodigo,
        codigoProduto: grupo.codigoProduto,
        descricao: grupo.descricao,
        local: grupo.local,
        localCodigo: grupo.localCodigo,
        quantidadeEsperada: grupo.quantidadeEsperada,
        motivo: diferenca !== 0 ? input.motivo : undefined,
        observacao: input.observacao,
        codigoLocalBipado: input.codigoLocalBipado,
        codigoProdutoBipado: input.codigoProdutoBipado,
        fotoChaveArmazenamento,
        tarefaId: tarefaDaConferencia ?? null,
      },
    });
  }

  // 1ª contagem divergindo: avisa o gestor. 2ª contagem registrada: a
  // solicitação foi atendida, some da lista de "aguardando".
  if (numeroContagem === 1 && diferenca !== 0) {
    await criarNotificacao(
      'DIVERGENCIA',
      input.chave,
      'Divergência na conferência',
      `${grupo.descricao} (${grupo.local}): esperado ${grupo.quantidadeEsperada}, contado ${input.quantidadeConferida}.`
    );
  }
  if (numeroContagem === 2 && solicitacao) {
    await prisma.itemSolicitacaoSegundaContagem.delete({ where: { id: solicitacao.id } }).catch(() => {});
  }

  const dto = await getItemAgrupado(input.chave, tarefaDaConferencia);
  if (!dto) throw new Error('Falha ao recarregar item conferido.');
  return dto;
}

export async function comentarDivergenciaItem(
  chave: string,
  comentarioAdmin: string,
  tarefaId?: string
): Promise<ItemAgrupadoDTO | null> {
  const alvo = await acharResultado(chave, 1, tarefaId);
  if (!alvo) throw new Error('Esse item ainda não foi conferido nesta tarefa.');

  await prisma.itemConferenciaResultado.update({
    where: { id: alvo.id },
    data: { comentarioAdmin },
  });

  return getItemAgrupado(chave, tarefaId);
}

export async function solicitarSegundaContagem(
  chave: string,
  solicitadoPorId: string,
  usuarioId: string | null,
  tarefaId?: string
): Promise<ItemAgrupadoDTO | null> {
  const existente = await acharSolicitacao(chave, tarefaId);

  if (existente) {
    await prisma.itemSolicitacaoSegundaContagem.update({
      where: { id: existente.id },
      data: { usuarioId },
    });
  } else {
    await prisma.itemSolicitacaoSegundaContagem.create({
      data: { chave, solicitadoPorId, usuarioId, tarefaId },
    });
  }

  return getItemAgrupado(chave, tarefaId);
}

// Apagar a 1ª contagem invalida qualquer 2ª contagem/pedido de recontagem que
// dependesse dela — o item volta pro estado "nunca conferido" (PENDENTE).
export async function apagarContagemItem(
  chave: string,
  numeroContagem: number,
  tarefaId?: string
): Promise<ItemAgrupadoDTO | null> {
  const contagem = await acharResultado(chave, numeroContagem, tarefaId);
  if (!contagem) return getItemAgrupado(chave, tarefaId);

  if (contagem.fotoChaveArmazenamento) {
    await removerFotoContagem(contagem.fotoChaveArmazenamento).catch(() => {});
  }
  await prisma.itemConferenciaResultado.delete({ where: { id: contagem.id } });

  if (numeroContagem === 1) {
    const contagem2 = await acharResultado(chave, 2, tarefaId);
    if (contagem2) {
      if (contagem2.fotoChaveArmazenamento) {
        await removerFotoContagem(contagem2.fotoChaveArmazenamento).catch(() => {});
      }
      await prisma.itemConferenciaResultado.delete({ where: { id: contagem2.id } });
    }
    const solicitacao = await acharSolicitacao(chave, tarefaId);
    if (solicitacao) {
      await prisma.itemSolicitacaoSegundaContagem
        .delete({ where: { id: solicitacao.id } })
        .catch(() => {});
    }
  }

  return getItemAgrupado(chave, tarefaId);
}

export async function getFotoContagem(chave: string, numeroContagem: number, tarefaId?: string) {
  // Sem tarefa dita, vale a foto da conferência mais recente daquele
  // produto+local — é o que a tela do gestor pede quando abre pela lista geral.
  const resultado = tarefaId
    ? await acharResultado(chave, numeroContagem, tarefaId)
    : await prisma.itemConferenciaResultado.findFirst({
        where: { chave, numeroContagem },
        orderBy: { dataConferencia: 'desc' },
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
    // O esperado da HORA da contagem, não o saldo de agora: é esse que
    // fecha a conta com `diferenca`.
    quantidadeEsperada: item.quantidadeEsperadaNaContagem ?? item.quantidadeEsperada,
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

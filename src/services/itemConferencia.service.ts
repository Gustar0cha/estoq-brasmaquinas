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
  quantidadeConferida: number | null;
  diferenca: number | null;
  status: StatusConferencia;
  atribuidoPara: string | null;
  motivo?: string;
  observacao?: string;
  comentarioAdmin?: string;
  dataConferencia?: string;
  notasOrigem: NotaOrigemDTO[];
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
}

function montarChave(empresaCodigo: string, codigoProduto: string, localCodigo: string): string {
  return `${empresaCodigo}|${codigoProduto}|${localCodigo}`;
}

// itemSankhyaId vem como "{nunota}-{codigoProduto}-{localCodigo}" (ver
// sankhya/client.ts) — mesma extração usada em movimentacoes.service.ts.
function extrairLocalCodigo(itemSankhyaId: string): string {
  return itemSankhyaId.split('-').pop()!;
}

interface GrupoAcumulado extends Omit<ItemAgrupadoDTO, 'quantidadeConferida' | 'diferenca' | 'status' | 'atribuidoPara'> {}

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

async function montarDTOs(grupos: Map<string, GrupoAcumulado>): Promise<ItemAgrupadoDTO[]> {
  const chaves = Array.from(grupos.keys());

  const [atribuicoes, resultados] = await Promise.all([
    prisma.itemAtribuicao.findMany({ where: { chave: { in: chaves } } }),
    prisma.itemConferenciaResultado.findMany({ where: { chave: { in: chaves } } }),
  ]);

  const atribuicaoPorChave = new Map(atribuicoes.map((a) => [a.chave, a]));
  const resultadoPorChave = new Map(resultados.map((r) => [r.chave, r]));

  return Array.from(grupos.values()).map((grupo) => {
    const atribuicao = atribuicaoPorChave.get(grupo.chave);
    const resultado = resultadoPorChave.get(grupo.chave);

    const status: StatusConferencia = !resultado
      ? 'PENDENTE'
      : resultado.diferenca === 0
        ? 'CONFERIDA'
        : 'DIVERGENCIA';

    return {
      ...grupo,
      quantidadeConferida: resultado?.quantidadeConferida ?? null,
      diferenca: resultado?.diferenca ?? null,
      status,
      atribuidoPara: atribuicao?.usuarioId ?? null,
      motivo: resultado?.motivo ?? undefined,
      observacao: resultado?.observacao ?? undefined,
      comentarioAdmin: resultado?.comentarioAdmin ?? undefined,
      dataConferencia: resultado?.dataConferencia?.toISOString(),
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

  const diferenca = input.quantidadeConferida - grupo.quantidadeEsperada;
  if (diferenca !== 0 && !input.motivo) {
    throw new Error('Motivo é obrigatório quando a contagem diverge do esperado.');
  }

  await prisma.itemConferenciaResultado.upsert({
    where: { chave: input.chave },
    create: {
      chave: input.chave,
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
    },
    update: {
      quantidadeConferida: input.quantidadeConferida,
      diferenca,
      conferidoPorId: input.conferidoPorId,
      dataConferencia: new Date(),
      motivo: diferenca !== 0 ? input.motivo : null,
      observacao: input.observacao ?? null,
    },
  });

  const dto = await getItemAgrupado(input.chave);
  if (!dto) throw new Error('Falha ao recarregar item conferido.');
  return dto;
}

export async function comentarDivergenciaItem(
  chave: string,
  comentarioAdmin: string
): Promise<ItemAgrupadoDTO | null> {
  await prisma.itemConferenciaResultado.update({
    where: { chave },
    data: { comentarioAdmin },
  });

  return getItemAgrupado(chave);
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
  notasOrigem: NotaOrigemDTO[];
}

export async function getDivergenciasItens(): Promise<DivergenciaItemDTO[]> {
  const itens = await getItensAgrupados({ status: 'DIVERGENCIA' });

  return itens.map((item) => ({
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
    notasOrigem: item.notasOrigem,
  }));
}

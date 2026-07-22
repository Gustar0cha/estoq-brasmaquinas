import ExcelJS from 'exceljs';

import { DiaReferencia, fimDoDiaBrasil, inicioDoDiaBrasil } from '../lib/datas';
import { prisma } from '../lib/prisma';
import { getDetalheConferenciaDiariaSankhya, getMovimentoDiarioSankhya } from '../sankhya/client';

export type StatusConferenciaDiaria = 'OK' | 'DIVERGENTE' | 'PENDENTE';

export interface LinhaConferenciaDiariaDTO {
  codigoProduto: string;
  descricao: string;
  local: string;
  localCodigo: string;
  empresaCodigo: string;
  empresaNome: string;
  estoqueAnterior: number;
  entradas: number;
  saidas: number;
  esperado: number;
  contado: number | null;
  diferenca: number | null;
  status: StatusConferenciaDiaria;
}

// A mesma combinação produto+local+empresa pode ter sido conferida mais de
// uma vez no dia (mais de uma nota mexeu no mesmo local). Fica com a
// contagem mais recente do dia — é a melhor aproximação do estado físico
// no fim do dia sem introduzir um fluxo de contagem paralelo.
async function buscarContagensDoDia(diaRef: DiaReferencia): Promise<Map<string, number>> {
  const itens = await prisma.itemConferido.findMany({
    where: {
      conferencia: {
        dataConferencia: { gte: inicioDoDiaBrasil(diaRef), lte: fimDoDiaBrasil(diaRef) },
      },
      quantidadeConferida: { not: null },
    },
    include: { conferencia: { select: { empresaCodigo: true, dataConferencia: true } } },
    orderBy: { conferencia: { dataConferencia: 'asc' } },
  });

  const mapa = new Map<string, number>();
  for (const item of itens) {
    const chave = `${item.conferencia.empresaCodigo}|${item.codigoProduto}|${item.localCodigo}`;
    // itens vieram ordenados por data crescente — o último a sobrescrever
    // a chave é sempre o mais recente do dia.
    mapa.set(chave, item.quantidadeConferida!);
  }
  return mapa;
}

export async function getConferenciaDiaria(diaRef: DiaReferencia): Promise<LinhaConferenciaDiariaDTO[]> {
  const [movimentoDiario, contagens] = await Promise.all([
    getMovimentoDiarioSankhya(diaRef),
    buscarContagensDoDia(diaRef),
  ]);

  return movimentoDiario.map((linha) => {
    const chave = `${linha.empresaCodigo}|${linha.codigoProduto}|${linha.localCodigo}`;
    const contado = contagens.get(chave) ?? null;
    const esperado = linha.estoqueAnterior + linha.entradas - linha.saidas;
    const diferenca = contado !== null ? contado - esperado : null;

    const status: StatusConferenciaDiaria =
      contado === null ? 'PENDENTE' : diferenca === 0 ? 'OK' : 'DIVERGENTE';

    return {
      codigoProduto: linha.codigoProduto,
      descricao: linha.descricao,
      local: linha.local,
      localCodigo: linha.localCodigo,
      empresaCodigo: linha.empresaCodigo,
      empresaNome: linha.empresaNome,
      estoqueAnterior: linha.estoqueAnterior,
      entradas: linha.entradas,
      saidas: linha.saidas,
      esperado,
      contado,
      diferenca,
      status,
    };
  });
}

const STATUS_LABEL: Record<StatusConferenciaDiaria, string> = {
  OK: 'OK',
  DIVERGENTE: 'Divergente',
  PENDENTE: 'Pendente (não conferido)',
};

export async function gerarConferenciaDiariaExcel(diaRef: DiaReferencia): Promise<ExcelJS.Buffer> {
  const linhas = await getConferenciaDiaria(diaRef);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Conferência diária');

  sheet.columns = [
    { header: 'Empresa', key: 'empresa', width: 26 },
    { header: 'Código Produto', key: 'codigoProduto', width: 16 },
    { header: 'Descrição', key: 'descricao', width: 36 },
    { header: 'Local', key: 'local', width: 26 },
    { header: 'Estoque Anterior', key: 'estoqueAnterior', width: 16 },
    { header: 'Entradas', key: 'entradas', width: 12 },
    { header: 'Saídas', key: 'saidas', width: 12 },
    { header: 'Esperado', key: 'esperado', width: 12 },
    { header: 'Contado', key: 'contado', width: 12 },
    { header: 'Diferença', key: 'diferenca', width: 12 },
    { header: 'Status', key: 'status', width: 20 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF024742' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const linha of linhas) {
    sheet.addRow({
      empresa: linha.empresaNome,
      codigoProduto: linha.codigoProduto,
      descricao: linha.descricao,
      local: linha.local,
      estoqueAnterior: linha.estoqueAnterior,
      entradas: linha.entradas,
      saidas: linha.saidas,
      esperado: linha.esperado,
      contado: linha.contado ?? '',
      diferenca: linha.diferenca ?? '',
      status: STATUS_LABEL[linha.status],
    });
  }

  return workbook.xlsx.writeBuffer();
}

export interface ContagemDetalheDTO {
  quantidadeConferida: number;
  numeroNota: string;
  conferidoPorNome: string;
  dataConferencia: string; // ISO
}

export interface DetalheConferenciaDiariaDTO {
  codigoProduto: string;
  descricao: string;
  local: string;
  empresaCodigo: string;
  empresaNome: string;
  estoqueAnterior: { data: string | null; quantidade: number };
  movimentos: {
    numeroNota: string;
    tipo: 'ENTRADA' | 'SAIDA';
    parceiro: string;
    quantidade: number;
    dataMovimentacao: string;
  }[];
  entradas: number;
  saidas: number;
  esperado: number;
  contagem: ContagemDetalheDTO | null;
  diferenca: number | null;
  status: StatusConferenciaDiaria;
}

async function buscarContagemDetalhe(
  diaRef: DiaReferencia,
  empresaCodigo: string,
  codigoProduto: string,
  localCodigo: string
): Promise<ContagemDetalheDTO | null> {
  const item = await prisma.itemConferido.findFirst({
    where: {
      codigoProduto,
      localCodigo,
      quantidadeConferida: { not: null },
      conferencia: {
        empresaCodigo,
        dataConferencia: { gte: inicioDoDiaBrasil(diaRef), lte: fimDoDiaBrasil(diaRef) },
      },
    },
    include: { conferencia: { include: { conferidoPor: { select: { nome: true } } } } },
    orderBy: { conferencia: { dataConferencia: 'desc' } },
  });

  if (!item) return null;

  return {
    quantidadeConferida: item.quantidadeConferida!,
    numeroNota: item.conferencia.numeroNota,
    conferidoPorNome: item.conferencia.conferidoPor.nome,
    dataConferencia: item.conferencia.dataConferencia.toISOString(),
  };
}

// Drill-down de uma linha da conferência diária — pra validar/auditar a
// conta com quem não acompanhou a query (ex: a gerência do estoque).
export async function getDetalheConferenciaDiaria(
  diaRef: DiaReferencia,
  empresaCodigo: string,
  codigoProduto: string,
  localCodigo: string,
  empresaNome: string,
  descricao: string,
  local: string
): Promise<DetalheConferenciaDiariaDTO> {
  const [sankhya, contagem] = await Promise.all([
    getDetalheConferenciaDiariaSankhya(diaRef, codigoProduto, localCodigo, empresaCodigo),
    buscarContagemDetalhe(diaRef, empresaCodigo, codigoProduto, localCodigo),
  ]);

  const entradas = sankhya.movimentos
    .filter((m) => m.tipo === 'ENTRADA')
    .reduce((soma, m) => soma + m.quantidade, 0);
  const saidas = sankhya.movimentos
    .filter((m) => m.tipo === 'SAIDA')
    .reduce((soma, m) => soma + m.quantidade, 0);
  const esperado = sankhya.estoqueAnterior.quantidade + entradas - saidas;
  const diferenca = contagem ? contagem.quantidadeConferida - esperado : null;
  const status: StatusConferenciaDiaria =
    contagem === null ? 'PENDENTE' : diferenca === 0 ? 'OK' : 'DIVERGENTE';

  return {
    codigoProduto,
    descricao,
    local,
    empresaCodigo,
    empresaNome,
    estoqueAnterior: sankhya.estoqueAnterior,
    movimentos: sankhya.movimentos,
    entradas,
    saidas,
    esperado,
    contagem,
    diferenca,
    status,
  };
}

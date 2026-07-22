import ExcelJS from 'exceljs';

import { prisma } from '../lib/prisma';
import { getMovimentoDiarioSankhya } from '../sankhya/client';

export type StatusConferenciaDiaria = 'OK' | 'DIVERGENTE' | 'PENDENTE';

export interface LinhaConferenciaDiariaDTO {
  codigoProduto: string;
  descricao: string;
  local: string;
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

function inicioDoDia(data: Date): Date {
  const copia = new Date(data);
  copia.setHours(0, 0, 0, 0);
  return copia;
}

function fimDoDia(data: Date): Date {
  const copia = new Date(data);
  copia.setHours(23, 59, 59, 999);
  return copia;
}

// A mesma combinação produto+local+empresa pode ter sido conferida mais de
// uma vez no dia (mais de uma nota mexeu no mesmo local). Fica com a
// contagem mais recente do dia — é a melhor aproximação do estado físico
// no fim do dia sem introduzir um fluxo de contagem paralelo.
async function buscarContagensDoDia(data: Date): Promise<Map<string, number>> {
  const itens = await prisma.itemConferido.findMany({
    where: {
      conferencia: {
        dataConferencia: { gte: inicioDoDia(data), lte: fimDoDia(data) },
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

export async function getConferenciaDiaria(data: Date): Promise<LinhaConferenciaDiariaDTO[]> {
  const [movimentoDiario, contagens] = await Promise.all([
    getMovimentoDiarioSankhya(data),
    buscarContagensDoDia(data),
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

export async function gerarConferenciaDiariaExcel(data: Date): Promise<ExcelJS.Buffer> {
  const linhas = await getConferenciaDiaria(data);

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

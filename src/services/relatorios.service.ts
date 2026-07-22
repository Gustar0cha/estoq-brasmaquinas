import ExcelJS from 'exceljs';

import { getMovimentacoes, MovimentacaoDTO } from './movimentacoes.service';
import { TipoMovimentacaoSankhya } from '../sankhya/types';
import { StatusConferencia } from './movimentacoes.service';

export interface FiltroRelatorio {
  tipo?: TipoMovimentacaoSankhya;
  status?: StatusConferencia;
  atribuidoPara?: string;
  dataInicio?: Date;
  dataFim?: Date;
  empresaCodigo?: string;
  somenteDivergencias?: boolean;
}

function filtrarPorPeriodoEEmpresa(
  movimentacoes: MovimentacaoDTO[],
  filtro: FiltroRelatorio
): MovimentacaoDTO[] {
  return movimentacoes.filter((m) => {
    const data = new Date(m.dataMovimentacao);
    if (filtro.dataInicio && data < filtro.dataInicio) return false;
    if (filtro.dataFim && data > filtro.dataFim) return false;
    if (filtro.empresaCodigo && m.empresaCodigo !== filtro.empresaCodigo) return false;
    return true;
  });
}

const STATUS_LABEL: Record<StatusConferencia, string> = {
  PENDENTE: 'Pendente',
  CONFERIDA: 'Conferida',
  DIVERGENCIA: 'Com divergência',
};

export async function gerarRelatorioExcel(filtro: FiltroRelatorio): Promise<ExcelJS.Buffer> {
  const movimentacoes = await getMovimentacoes({
    tipo: filtro.tipo,
    status: filtro.status,
    atribuidoPara: filtro.atribuidoPara,
  });
  const filtradas = filtrarPorPeriodoEEmpresa(movimentacoes, filtro);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(filtro.somenteDivergencias ? 'Divergências' : 'Movimentações');

  sheet.columns = [
    { header: 'Nota', key: 'nota', width: 12 },
    { header: 'Empresa', key: 'empresa', width: 26 },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Parceiro', key: 'parceiro', width: 28 },
    { header: 'Data', key: 'data', width: 14 },
    { header: 'Status da Nota', key: 'status', width: 16 },
    { header: 'Código Produto', key: 'codigoProduto', width: 16 },
    { header: 'Descrição', key: 'descricao', width: 36 },
    { header: 'Local', key: 'local', width: 26 },
    { header: 'Qtd. Esperada (local)', key: 'quantidadeEsperada', width: 18 },
    { header: 'Qtd. Conferida', key: 'quantidadeConferida', width: 16 },
    { header: 'Diferença', key: 'diferenca', width: 12 },
    { header: 'Motivo Divergência', key: 'motivo', width: 24 },
    { header: 'Observação', key: 'observacao', width: 30 },
    { header: 'Comentário Admin', key: 'comentarioAdmin', width: 30 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF024742' },
  };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const mov of filtradas) {
    for (const item of mov.itens) {
      const divergencia = mov.divergencias.find((d) => d.itemId === item.id);
      if (filtro.somenteDivergencias && !divergencia) continue;

      const diferenca =
        divergencia?.diferenca ??
        (item.quantidadeConferida !== null ? item.quantidadeConferida - item.quantidadeEsperada : null);

      sheet.addRow({
        nota: mov.numeroNota,
        empresa: mov.empresaNome,
        tipo: mov.tipo === 'ENTRADA' ? 'Entrada' : 'Saída',
        parceiro: mov.parceiro,
        data: new Date(mov.dataMovimentacao).toLocaleDateString('pt-BR'),
        status: STATUS_LABEL[mov.status],
        codigoProduto: item.codigoProduto,
        descricao: item.descricao,
        local: item.local,
        quantidadeEsperada: item.quantidadeEsperada,
        quantidadeConferida: item.quantidadeConferida ?? '',
        diferenca: diferenca ?? '',
        motivo: divergencia?.motivo ?? '',
        observacao: divergencia?.observacao ?? '',
        comentarioAdmin: divergencia?.comentarioAdmin ?? '',
      });
    }
  }

  return workbook.xlsx.writeBuffer();
}

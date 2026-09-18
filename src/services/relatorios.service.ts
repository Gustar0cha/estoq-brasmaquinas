import ExcelJS from 'exceljs';

import { prisma } from '../lib/prisma';
import { ContagemItemDTO, getContagemItens } from './contagem.service';
import { getItensAgrupados, ItemAgrupadoDTO } from './itemConferencia.service';
import {
  chaveReserva,
  chaveSaldoItem,
  getReservadosSankhya,
  getSaldosAtuaisPorItem,
} from '../sankhya/client';
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

function filtrarPorPeriodoEEmpresa(itens: ItemAgrupadoDTO[], filtro: FiltroRelatorio): ItemAgrupadoDTO[] {
  return itens.filter((item) => {
    if (filtro.empresaCodigo && item.empresaCodigo !== filtro.empresaCodigo) return false;
    if (!filtro.dataInicio && !filtro.dataFim) return true;
    // Um grupo "cai" no período se alguma das notas que o compõem caiu nele
    // (mesmo critério usado na tela de Movimentações do app).
    return item.notasOrigem.some((nota) => {
      const data = new Date(nota.dataMovimentacao);
      if (filtro.dataInicio && data < filtro.dataInicio) return false;
      if (filtro.dataFim && data > filtro.dataFim) return false;
      return true;
    });
  });
}


export async function gerarRelatorioExcel(filtro: FiltroRelatorio): Promise<ExcelJS.Buffer> {
  const itens = await getItensAgrupados({
    tipo: filtro.tipo,
    status: filtro.somenteDivergencias ? undefined : filtro.status,
    atribuidoPara: filtro.atribuidoPara,
  });
  const filtrados = filtrarPorPeriodoEEmpresa(itens, filtro).filter((item) =>
    filtro.somenteDivergencias ? item.status === 'DIVERGENCIA' || item.status === 'AGUARDANDO_SEGUNDA_CONTAGEM' : true
  );

  const reservas = await getReservadosSankhya();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(filtro.somenteDivergencias ? 'Divergências' : 'Itens');

  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Descrição', key: 'descricao', width: 40 },
    { header: 'Local', key: 'local', width: 26 },
    { header: 'Qtd. Esperada', key: 'quantidadeEsperada', width: 16 },
    { header: 'Qtd. Reservada (Sankhya)', key: 'quantidadeReservada', width: 20 },
    { header: 'Qtd. 1ª Conferência', key: 'quantidadeConferida1', width: 18 },
    { header: 'Qtd. 2ª Conferência', key: 'quantidadeConferida2', width: 18 },
    { header: 'Motivo Divergência', key: 'motivo', width: 24 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF024742' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const item of filtrados) {
    const linha = sheet.addRow({
      sku: item.codigoProduto,
      descricao: item.descricao,
      local: item.local,
      quantidadeEsperada: item.quantidadeEsperada,
      quantidadeReservada:
        reservas.get(chaveReserva(item.codigoProduto, item.localCodigo, item.empresaCodigo)) ?? 0,
      quantidadeConferida1: item.quantidadeConferida ?? '',
      quantidadeConferida2: item.quantidadeConferida2 ?? '',
      motivo: item.motivo ?? '',
    });
  }

  return workbook.xlsx.writeBuffer();
}


export interface FiltroRelatorioContagem {
  dataInicio?: Date;
  dataFim?: Date;
  somenteDivergencias?: boolean;
}

// Relatório da Contagem física (auditoria de estoque via cópia TGFCTE) — a
// contagem é livre (cada colaborador conta o que quiser, quando quiser), não
// existe mais sessão pra agrupar; o relatório filtra por período de início
// da contagem.
export async function gerarRelatorioContagemExcel(filtro: FiltroRelatorioContagem): Promise<ExcelJS.Buffer> {
  const somenteDivergencias = Boolean(filtro.somenteDivergencias);
  const base = { dataInicio: filtro.dataInicio, dataFim: filtro.dataFim };

  const itens = somenteDivergencias
    ? [
        ...(await getContagemItens({ ...base, status: 'DIVERGENCIA' })),
        ...(await getContagemItens({ ...base, status: 'DIVERGENCIA_LOCAL' })),
        ...(await getContagemItens({ ...base, status: 'AGUARDANDO_SEGUNDA_CONTAGEM' })),
        ...(await getContagemItens({ ...base, status: 'SEGUNDA_EM_ANDAMENTO' })),
      ]
    : await getContagemItens(base);

  // Nome de quem ficou responsável — a atribuição agora é rastreada de
  // verdade (atribuidoParaId), então dá pra dizer quem contou cada linha.
  const usuarios = await prisma.usuario.findMany({ select: { id: true, nome: true } });
  const nomePorId = new Map(usuarios.map((u) => [u.id, u.nome]));
  const reservas = await getReservadosSankhya();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(somenteDivergencias ? 'Divergências' : 'Contagem');

  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Descrição', key: 'descricao', width: 40 },
    { header: 'Local', key: 'local', width: 26 },
    { header: 'Rua', key: 'rua', width: 8 },
    { header: 'Prédio', key: 'predio', width: 8 },
    { header: 'Atribuído para', key: 'atribuidoPara', width: 22 },
    { header: 'Divergência de Local', key: 'divergenciaLocal', width: 18 },
    { header: 'Local Esperado no Sistema', key: 'localEsperado', width: 30 },
    { header: 'Qtd. Cópia de Estoque', key: 'quantidadeEsperada', width: 18 },
    { header: 'Qtd. Reservada (Sankhya)', key: 'quantidadeReservada', width: 20 },
    { header: 'Qtd. 1ª Contagem', key: 'quantidadeConferida1', width: 16 },
    { header: 'Conferido por (1ª)', key: 'conferidoPor1', width: 22 },
    { header: 'Data 1ª Contagem', key: 'dataConferencia1', width: 18 },
    { header: 'Qtd. 2ª Contagem', key: 'quantidadeConferida2', width: 16 },
    { header: 'Conferido por (2ª)', key: 'conferidoPor2', width: 22 },
    { header: 'Data 2ª Contagem', key: 'dataConferencia2', width: 18 },
    { header: 'Diferença entre Contagens (2ª − 1ª)', key: 'diferencaEntreContagens', width: 28 },
    { header: 'Resultado da Recontagem', key: 'resultadoRecontagem', width: 26 },
    { header: 'Motivo Divergência', key: 'motivo', width: 24 },
    { header: 'Motivo 2ª Contagem', key: 'motivo2', width: 24 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF024742' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const item of itens as ContagemItemDTO[]) {
    const linha = sheet.addRow({
      sku: item.codigoProduto,
      descricao: item.descricao,
      local: item.local,
      rua: item.rua ?? '',
      predio: item.predio ?? '',
      atribuidoPara: item.atribuidoPara ? (nomePorId.get(item.atribuidoPara) ?? '') : '',
      divergenciaLocal: item.divergenciaLocal ? 'SIM' : '',
      localEsperado: item.localEsperado ?? '',
      quantidadeEsperada: item.quantidadeEsperada,
      quantidadeReservada:
        reservas.get(chaveReserva(item.codigoProduto, item.localCodigo, item.empresaCodigo)) ?? 0,
      quantidadeConferida1: item.quantidadeConferida ?? '',
      conferidoPor1: item.conferidoPorId ? (nomePorId.get(item.conferidoPorId) ?? '') : '',
      dataConferencia1: formatarDataHora(item.dataConferencia),
      quantidadeConferida2: item.quantidadeConferida2 ?? '',
      conferidoPor2: item.conferidoPor2Id ? (nomePorId.get(item.conferidoPor2Id) ?? '') : '',
      dataConferencia2: formatarDataHora(item.dataConferencia2),
      diferencaEntreContagens: diferencaEntreContagens(item) ?? '',
      resultadoRecontagem: resultadoDaRecontagem(item),
      motivo: item.motivo ?? '',
      motivo2: item.motivo2 ?? '',
    });
  }

  return workbook.xlsx.writeBuffer();
}

// A 2ª contagem existe pra conferir a 1ª. Quando as duas batem, o número está
// confirmado; quando não batem, quem contou primeiro errou — é essa a
// informação que o gestor precisa pra saber em quem confiar.
//
// Sem 2ª contagem não há o que concluir: a coluna fica vazia em vez de dizer
// "OK", que daria uma confiança que ninguém verificou.
function diferencaEntreContagens(item: ContagemItemDTO): number | null {
  if (item.quantidadeConferida === null || item.quantidadeConferida === undefined) return null;
  if (item.quantidadeConferida2 === undefined) return null;
  return item.quantidadeConferida2 - item.quantidadeConferida;
}

function resultadoDaRecontagem(item: ContagemItemDTO): string {
  const diferenca = diferencaEntreContagens(item);
  if (diferenca === null) return '';
  if (diferenca === 0) return 'Confirmada (1ª e 2ª bateram)';

  const paraMais = diferenca > 0;
  return `ERRO NA 1ª CONTAGEM (contou ${Math.abs(diferenca)} a ${paraMais ? 'menos' : 'mais'})`;
}

function formatarDataHora(iso?: string): string {
  if (!iso) return '';
  const data = new Date(iso);
  return Number.isNaN(data.getTime()) ? '' : data.toLocaleString('pt-BR');
}

export interface FiltroRelatorioSistemaVsContado {
  dataInicio?: Date;
  dataFim?: Date;
}

// Compara o que o sistema tem HOJE (estoque atual, buscado ao vivo — não o
// retrato de quando a contagem foi feita) contra o que foi registrado nas
// contagens/divergências do período — mostra se o estoque "andou" desde a
// contagem, útil pra saber se ainda vale a pena confiar num número contado
// há um tempo.
export async function gerarRelatorioSistemaVsContadoExcel(
  filtro: FiltroRelatorioSistemaVsContado
): Promise<ExcelJS.Buffer> {
  const itens = (await getContagemItens(filtro)).filter((item) => item.quantidadeConferida !== null);
  const reservas = await getReservadosSankhya();
  // Uma consulta em lote no lugar de uma por linha do relatório.
  const saldosAtuais = await getSaldosAtuaisPorItem(itens);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Sistema vs. Contado');

  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Descrição', key: 'descricao', width: 40 },
    { header: 'Local', key: 'local', width: 26 },
    { header: 'Qtd. Sistema (atual)', key: 'quantidadeSistema', width: 18 },
    { header: 'Qtd. Reservada (Sankhya)', key: 'quantidadeReservada', width: 20 },
    { header: 'Qtd. 1ª Contagem', key: 'quantidadeConferida1', width: 16 },
    { header: 'Qtd. 2ª Contagem', key: 'quantidadeConferida2', width: 16 },
    { header: 'Última Contagem', key: 'ultimaContagem', width: 14 },
    { header: 'Resultado da Recontagem', key: 'resultadoRecontagem', width: 26 },
    { header: 'Diferença (sistema atual − última contagem)', key: 'diferencaAtual', width: 30 },
    { header: 'Data da Contagem', key: 'dataContagem', width: 18 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF024742' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const item of itens as ContagemItemDTO[]) {
    const saldoAtual = saldosAtuais.get(chaveSaldoItem(item.codigoProduto, item.localCodigo));
    const ultimaContagem = item.quantidadeConferida2 ?? item.quantidadeConferida ?? 0;

    sheet.addRow({
      sku: item.codigoProduto,
      descricao: item.descricao,
      local: item.local,
      quantidadeSistema: saldoAtual ?? '',
      quantidadeReservada:
        reservas.get(chaveReserva(item.codigoProduto, item.localCodigo, item.empresaCodigo)) ?? 0,
      quantidadeConferida1: item.quantidadeConferida ?? '',
      quantidadeConferida2: item.quantidadeConferida2 ?? '',
      ultimaContagem: item.quantidadeConferida2 !== undefined ? '2ª' : '1ª',
      resultadoRecontagem: resultadoDaRecontagem(item),
      diferencaAtual: saldoAtual !== undefined ? saldoAtual - ultimaContagem : '',
      dataContagem: item.dataConferencia2 ?? item.dataConferencia ?? '',
    });
  }

  return workbook.xlsx.writeBuffer();
}

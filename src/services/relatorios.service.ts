import ExcelJS from 'exceljs';

import { ContagemItemDTO, getContagemItens, getFotoContagemItem } from './contagem.service';
import { getFotoContagem, getItensAgrupados, ItemAgrupadoDTO } from './itemConferencia.service';
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

async function coletarBufferFoto(chave: string, numeroContagem: number): Promise<Buffer | null> {
  try {
    const stream = await getFotoContagem(chave, numeroContagem);
    if (!stream) return null;
    const partes: Buffer[] = [];
    for await (const parte of stream) {
      partes.push(parte as Buffer);
    }
    return Buffer.concat(partes);
  } catch {
    return null;
  }
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

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(filtro.somenteDivergencias ? 'Divergências' : 'Itens');

  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Descrição', key: 'descricao', width: 40 },
    { header: 'Local', key: 'local', width: 26 },
    { header: 'Qtd. Esperada', key: 'quantidadeEsperada', width: 16 },
    { header: 'Qtd. 1ª Conferência', key: 'quantidadeConferida1', width: 18 },
    { header: 'Qtd. 2ª Conferência', key: 'quantidadeConferida2', width: 18 },
    { header: 'Motivo Divergência', key: 'motivo', width: 24 },
    { header: 'Foto 1ª Contagem', key: 'foto1', width: 22 },
    { header: 'Foto 2ª Contagem', key: 'foto2', width: 22 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF024742' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const item of filtrados) {
    const linha = sheet.addRow({
      sku: item.codigoProduto,
      descricao: item.descricao,
      local: item.local,
      quantidadeEsperada: item.quantidadeEsperada,
      quantidadeConferida1: item.quantidadeConferida ?? '',
      quantidadeConferida2: item.quantidadeConferida2 ?? '',
      motivo: item.motivo ?? '',
    });
    linha.height = 70;

    if (item.temFoto) {
      const buffer = await coletarBufferFoto(item.chave, 1);
      if (buffer) {
        const imageId = workbook.addImage({ base64: `data:image/jpeg;base64,${buffer.toString('base64')}`, extension: 'jpeg' });
        sheet.addImage(imageId, {
          tl: { col: 7, row: linha.number - 1 },
          ext: { width: 90, height: 90 },
        });
      }
    }
    if (item.temFoto2) {
      const buffer = await coletarBufferFoto(item.chave, 2);
      if (buffer) {
        const imageId = workbook.addImage({ base64: `data:image/jpeg;base64,${buffer.toString('base64')}`, extension: 'jpeg' });
        sheet.addImage(imageId, {
          tl: { col: 8, row: linha.number - 1 },
          ext: { width: 90, height: 90 },
        });
      }
    }
  }

  return workbook.xlsx.writeBuffer();
}

async function coletarBufferFotoContagem(itemId: string, numeroContagem: number): Promise<Buffer | null> {
  try {
    const stream = await getFotoContagemItem(itemId, numeroContagem);
    if (!stream) return null;
    const partes: Buffer[] = [];
    for await (const parte of stream) {
      partes.push(parte as Buffer);
    }
    return Buffer.concat(partes);
  } catch {
    return null;
  }
}

// Relatório da Contagem física (auditoria de estoque via cópia TGFCTE) —
// sempre de UMA sessão específica, já que cada sessão é um retrato
// congelado próprio (não faz sentido misturar quantidades esperadas de
// sessões diferentes na mesma planilha).
export async function gerarRelatorioContagemExcel(
  contagemId: string,
  somenteDivergencias: boolean
): Promise<ExcelJS.Buffer> {
  const itens = somenteDivergencias
    ? [
        ...(await getContagemItens({ contagemId, status: 'DIVERGENCIA' })),
        ...(await getContagemItens({ contagemId, status: 'AGUARDANDO_SEGUNDA_CONTAGEM' })),
      ]
    : await getContagemItens({ contagemId });

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(somenteDivergencias ? 'Divergências' : 'Contagem');

  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Descrição', key: 'descricao', width: 40 },
    { header: 'Local', key: 'local', width: 26 },
    { header: 'Qtd. Cópia de Estoque', key: 'quantidadeEsperada', width: 18 },
    { header: 'Qtd. 1ª Contagem', key: 'quantidadeConferida1', width: 16 },
    { header: 'Qtd. 2ª Contagem', key: 'quantidadeConferida2', width: 16 },
    { header: 'Motivo Divergência', key: 'motivo', width: 24 },
    { header: 'Foto 1ª Contagem', key: 'foto1', width: 22 },
    { header: 'Foto 2ª Contagem', key: 'foto2', width: 22 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF024742' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  for (const item of itens as ContagemItemDTO[]) {
    const linha = sheet.addRow({
      sku: item.codigoProduto,
      descricao: item.descricao,
      local: item.local,
      quantidadeEsperada: item.quantidadeEsperada,
      quantidadeConferida1: item.quantidadeConferida ?? '',
      quantidadeConferida2: item.quantidadeConferida2 ?? '',
      motivo: item.motivo ?? '',
    });
    linha.height = 70;

    if (item.temFoto) {
      const buffer = await coletarBufferFotoContagem(item.id, 1);
      if (buffer) {
        const imageId = workbook.addImage({ base64: `data:image/jpeg;base64,${buffer.toString('base64')}`, extension: 'jpeg' });
        sheet.addImage(imageId, { tl: { col: 7, row: linha.number - 1 }, ext: { width: 90, height: 90 } });
      }
    }
    if (item.temFoto2) {
      const buffer = await coletarBufferFotoContagem(item.id, 2);
      if (buffer) {
        const imageId = workbook.addImage({ base64: `data:image/jpeg;base64,${buffer.toString('base64')}`, extension: 'jpeg' });
        sheet.addImage(imageId, { tl: { col: 8, row: linha.number - 1 }, ext: { width: 90, height: 90 } });
      }
    }
  }

  return workbook.xlsx.writeBuffer();
}

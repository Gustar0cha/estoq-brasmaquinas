import ExcelJS from 'exceljs';

import { prisma } from '../lib/prisma';
import { ContagemItemDTO, getContagemItens, getFotoContagemItem } from './contagem.service';
import { getFotoContagem, getItensAgrupados, ItemAgrupadoDTO } from './itemConferencia.service';
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
  // Fotos deixam a planilha pesada e lenta de abrir, então ficam de fora por
  // padrão — quem precisa da evidência visual pede explicitamente.
  incluirFotos?: boolean;
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

  const reservas = await getReservadosSankhya();

  const comFotos = Boolean(filtro.incluirFotos);
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
    ...(comFotos
      ? [
          { header: 'Foto 1ª Contagem', key: 'foto1', width: 22 },
          { header: 'Foto 2ª Contagem', key: 'foto2', width: 22 },
        ]
      : []),
  ];
  // Índice da 1ª coluna de foto: calculado, não fixo — sem fotos as colunas
  // anteriores não mudam, mas fixar o número quebraria ao mexer na planilha.
  const colunaFoto = sheet.columns.length - 2;
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
    if (!comFotos) continue;
    linha.height = 70;

    if (item.temFoto) {
      const buffer = await coletarBufferFoto(item.chave, 1);
      if (buffer) {
        const imageId = workbook.addImage({ base64: `data:image/jpeg;base64,${buffer.toString('base64')}`, extension: 'jpeg' });
        sheet.addImage(imageId, {
          tl: { col: colunaFoto, row: linha.number - 1 },
          ext: { width: 90, height: 90 },
        });
      }
    }
    if (item.temFoto2) {
      const buffer = await coletarBufferFoto(item.chave, 2);
      if (buffer) {
        const imageId = workbook.addImage({ base64: `data:image/jpeg;base64,${buffer.toString('base64')}`, extension: 'jpeg' });
        sheet.addImage(imageId, {
          tl: { col: colunaFoto + 1, row: linha.number - 1 },
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

export interface FiltroRelatorioContagem {
  dataInicio?: Date;
  dataFim?: Date;
  somenteDivergencias?: boolean;
  // Inventário. Ausente = todos, que é o acumulado.
  cicloId?: string;
  // Ver FiltroRelatorio.incluirFotos.
  incluirFotos?: boolean;
}

// Relatório da Contagem física (auditoria de estoque via cópia TGFCTE) — a
// contagem é livre (cada colaborador conta o que quiser, quando quiser), não
// existe mais sessão pra agrupar; o relatório filtra por período de início
// da contagem.
export async function gerarRelatorioContagemExcel(filtro: FiltroRelatorioContagem): Promise<ExcelJS.Buffer> {
  const somenteDivergencias = Boolean(filtro.somenteDivergencias);
  const comFotos = Boolean(filtro.incluirFotos);
  const base = { dataInicio: filtro.dataInicio, dataFim: filtro.dataFim, cicloId: filtro.cicloId };

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
    ...(comFotos
      ? [
          { header: 'Foto 1ª Contagem', key: 'foto1', width: 22 },
          { header: 'Foto 2ª Contagem', key: 'foto2', width: 22 },
        ]
      : []),
  ];
  const colunaFoto = sheet.columns.length - 2;
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
    if (!comFotos) continue;
    linha.height = 70;

    if (item.temFoto) {
      const buffer = await coletarBufferFotoContagem(item.id, 1);
      if (buffer) {
        const imageId = workbook.addImage({ base64: `data:image/jpeg;base64,${buffer.toString('base64')}`, extension: 'jpeg' });
        sheet.addImage(imageId, { tl: { col: colunaFoto, row: linha.number - 1 }, ext: { width: 90, height: 90 } });
      }
    }
    if (item.temFoto2) {
      const buffer = await coletarBufferFotoContagem(item.id, 2);
      if (buffer) {
        const imageId = workbook.addImage({ base64: `data:image/jpeg;base64,${buffer.toString('base64')}`, extension: 'jpeg' });
        sheet.addImage(imageId, { tl: { col: colunaFoto + 1, row: linha.number - 1 }, ext: { width: 90, height: 90 } });
      }
    }
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

// ---------------------------------------------------------------------------
// Uma contagem contra a anterior
// ---------------------------------------------------------------------------

export interface FiltroComparativoCiclos {
  cicloAtualId: string;
  cicloAnteriorId: string;
  // Só as linhas em que as duas contagens não deram o mesmo número.
  somenteMudancas?: boolean;
}

// Compara dois inventários item a item (produto + local).
//
// A pergunta que isso responde é "o que mudou de uma contagem pra outra" —
// item que passou a divergir, item que parou de divergir, e item que só
// existe em uma das duas. Esse último caso importa tanto quanto os outros:
// produto que sumiu da prateleira entre um inventário e o seguinte não
// aparece em nenhuma comparação que só olhe os itens em comum.
export async function gerarRelatorioComparativoCiclosExcel(
  filtro: FiltroComparativoCiclos
): Promise<ExcelJS.Buffer> {
  const [cicloAtual, cicloAnterior] = await Promise.all([
    prisma.cicloContagem.findUnique({ where: { id: filtro.cicloAtualId } }),
    prisma.cicloContagem.findUnique({ where: { id: filtro.cicloAnteriorId } }),
  ]);
  if (!cicloAtual || !cicloAnterior) throw new Error('Contagem não encontrada.');

  const [itensAtual, itensAnterior] = await Promise.all([
    getContagemItens({ cicloId: filtro.cicloAtualId }),
    getContagemItens({ cicloId: filtro.cicloAnteriorId }),
  ]);

  const chaveDe = (item: ContagemItemDTO) => `${item.codigoProduto}|${item.localCodigo}`;
  const porChaveAnterior = new Map(itensAnterior.map((i) => [chaveDe(i), i]));
  const porChaveAtual = new Map(itensAtual.map((i) => [chaveDe(i), i]));

  // A quantidade que vale é a da última contagem daquele item: se houve
  // recontagem, é ela que corrige a primeira.
  const contadoDe = (item?: ContagemItemDTO): number | null =>
    item ? (item.quantidadeConferida2 ?? item.quantidadeConferida) : null;

  const usuarios = await prisma.usuario.findMany({ select: { id: true, nome: true } });
  const nomePorId = new Map(usuarios.map((u) => [u.id, u.nome]));
  const quemContou = (item?: ContagemItemDTO) => {
    if (!item) return '';
    const id = item.conferidoPor2Id ?? item.conferidoPorId ?? item.atribuidoPara;
    return id ? (nomePorId.get(id) ?? '') : '';
  };

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Comparativo');

  sheet.columns = [
    { header: 'SKU', key: 'sku', width: 14 },
    { header: 'Descrição', key: 'descricao', width: 40 },
    { header: 'Local', key: 'local', width: 28 },
    { header: `Esperado (${cicloAnterior.nome})`, key: 'esperadoAnterior', width: 20 },
    { header: `Contado (${cicloAnterior.nome})`, key: 'contadoAnterior', width: 20 },
    { header: `Diferença (${cicloAnterior.nome})`, key: 'difAnterior', width: 20 },
    { header: `Esperado (${cicloAtual.nome})`, key: 'esperadoAtual', width: 20 },
    { header: `Contado (${cicloAtual.nome})`, key: 'contadoAtual', width: 20 },
    { header: `Diferença (${cicloAtual.nome})`, key: 'difAtual', width: 20 },
    { header: 'Variação entre as contagens', key: 'variacao', width: 26 },
    { header: 'O que mudou', key: 'situacao', width: 34 },
    { header: 'Quem contou (anterior)', key: 'quemAnterior', width: 22 },
    { header: 'Quem contou (atual)', key: 'quemAtual', width: 22 },
  ];
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF024742' } };
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

  const todasAsChaves = new Set([...porChaveAtual.keys(), ...porChaveAnterior.keys()]);

  for (const chave of [...todasAsChaves].sort()) {
    const atual = porChaveAtual.get(chave);
    const anterior = porChaveAnterior.get(chave);
    const referencia = atual ?? anterior!;

    const contadoAtual = contadoDe(atual);
    const contadoAnterior = contadoDe(anterior);
    const difAtual = atual && contadoAtual !== null ? contadoAtual - atual.quantidadeEsperada : null;
    const difAnterior =
      anterior && contadoAnterior !== null ? contadoAnterior - anterior.quantidadeEsperada : null;

    let situacao: string;
    if (!anterior) situacao = 'Só na contagem atual';
    else if (!atual) situacao = 'Só na contagem anterior';
    else if (contadoAtual === null || contadoAnterior === null) situacao = 'Sem contagem nos dois lados';
    else if (difAtual === 0 && difAnterior === 0) situacao = 'Bateu nas duas';
    else if (difAtual === 0 && difAnterior !== 0) situacao = 'Corrigiu: divergia e agora bate';
    else if (difAtual !== 0 && difAnterior === 0) situacao = 'Piorou: batia e agora diverge';
    else situacao = 'Diverge nas duas';

    const variacao =
      contadoAtual !== null && contadoAnterior !== null ? contadoAtual - contadoAnterior : null;

    if (filtro.somenteMudancas && situacao === 'Bateu nas duas') continue;

    sheet.addRow({
      sku: referencia.codigoProduto,
      descricao: referencia.descricao,
      local: referencia.local,
      esperadoAnterior: anterior ? anterior.quantidadeEsperada : '',
      contadoAnterior: contadoAnterior ?? '',
      difAnterior: difAnterior ?? '',
      esperadoAtual: atual ? atual.quantidadeEsperada : '',
      contadoAtual: contadoAtual ?? '',
      difAtual: difAtual ?? '',
      variacao: variacao ?? '',
      situacao,
      quemAnterior: quemContou(anterior),
      quemAtual: quemContou(atual),
    });
  }

  return workbook.xlsx.writeBuffer();
}

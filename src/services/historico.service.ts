import ExcelJS from 'exceljs';

import { prisma } from '../lib/prisma';

export interface FiltroHistorico {
  dataInicio?: Date;
  dataFim?: Date;
  empresaCodigo?: string;
  usuarioId?: string;
}

export interface ConferenciaHistoricoDTO {
  id: string;
  movimentacaoSankhyaId: string;
  numeroNota: string;
  tipo: string;
  parceiro: string;
  empresaCodigo: string;
  dataConferencia: string;
  conferidoPorId: string;
  conferidoPorNome: string;
  totalItens: number;
  totalContados: number;
  totalDivergencias: number;
}

export interface RankingOperadorDTO {
  usuarioId: string;
  nome: string;
  totalConferencias: number;
  totalItens: number;
  totalDivergencias: number;
}

export interface ResumoHistoricoDTO {
  totalConferencias: number;
  totalItens: number;
  totalDivergencias: number;
  taxaDivergencia: number;
  ranking: RankingOperadorDTO[];
  conferencias: ConferenciaHistoricoDTO[];
}

// Não depende do Sankhya: lê só o que já foi salvo no Postgres a cada
// conferência finalizada, então cobre tudo que o app já coletou em produção
// (inclusive movimentações que hoje podem não existir mais como "pendentes"
// vivas na API do Sankhya).
async function buscarConferencias(filtro: FiltroHistorico): Promise<ConferenciaHistoricoDTO[]> {
  const conferencias = await prisma.conferenciaResultado.findMany({
    where: {
      empresaCodigo: filtro.empresaCodigo,
      conferidoPorId: filtro.usuarioId,
      dataConferencia: {
        gte: filtro.dataInicio,
        lte: filtro.dataFim,
      },
    },
    include: { itens: true, divergencias: true, conferidoPor: true },
    orderBy: { dataConferencia: 'desc' },
  });

  return conferencias.map((c) => ({
    id: c.id,
    movimentacaoSankhyaId: c.movimentacaoSankhyaId,
    numeroNota: c.numeroNota,
    tipo: c.tipo,
    parceiro: c.parceiro,
    empresaCodigo: c.empresaCodigo,
    dataConferencia: c.dataConferencia.toISOString(),
    conferidoPorId: c.conferidoPorId,
    conferidoPorNome: c.conferidoPor.nome,
    totalItens: c.itens.length,
    totalContados: c.itens.filter((item) => item.quantidadeConferida !== null).length,
    totalDivergencias: c.divergencias.length,
  }));
}

function montarRanking(conferencias: ConferenciaHistoricoDTO[]): RankingOperadorDTO[] {
  const porOperador = new Map<string, RankingOperadorDTO>();

  for (const c of conferencias) {
    const atual = porOperador.get(c.conferidoPorId) ?? {
      usuarioId: c.conferidoPorId,
      nome: c.conferidoPorNome,
      totalConferencias: 0,
      totalItens: 0,
      totalDivergencias: 0,
    };
    atual.totalConferencias += 1;
    atual.totalItens += c.totalItens;
    atual.totalDivergencias += c.totalDivergencias;
    porOperador.set(c.conferidoPorId, atual);
  }

  return Array.from(porOperador.values()).sort((a, b) => b.totalConferencias - a.totalConferencias);
}

export async function getHistoricoContagem(filtro: FiltroHistorico): Promise<ResumoHistoricoDTO> {
  const conferencias = await buscarConferencias(filtro);

  const totalItens = conferencias.reduce((soma, c) => soma + c.totalItens, 0);
  const totalDivergencias = conferencias.reduce((soma, c) => soma + c.totalDivergencias, 0);

  return {
    totalConferencias: conferencias.length,
    totalItens,
    totalDivergencias,
    taxaDivergencia: totalItens > 0 ? (totalDivergencias / totalItens) * 100 : 0,
    ranking: montarRanking(conferencias),
    conferencias,
  };
}

export interface RegistroComFotoDTO {
  origem: 'movimentacao' | 'contagem';
  chave: string;
  numeroContagem: number;
  descricao: string;
  local: string;
  quantidadeConferida: number;
  conferidoPorId: string;
  dataConferencia: string;
}

// Junta as fotos das duas fontes que hoje registram foto de contagem — a
// conferência por movimentação (item_conferencia_resultados) e a contagem
// física livre (contagem_itens) — numa lista só, ordenada por data. Não usa
// ConferenciaResultado (o resto do histórico acima) porque aquele fluxo
// antigo nunca teve campo de foto.
export async function getRegistrosComFoto(filtro: FiltroHistorico): Promise<RegistroComFotoDTO[]> {
  const [movimentacao, contagem] = await Promise.all([
    prisma.itemConferenciaResultado.findMany({
      where: {
        fotoChaveArmazenamento: { not: null },
        dataConferencia: { gte: filtro.dataInicio, lte: filtro.dataFim },
      },
      orderBy: { dataConferencia: 'desc' },
    }),
    prisma.contagemItem.findMany({
      where: {
        OR: [{ fotoChaveArmazenamento: { not: null } }, { fotoChaveArmazenamento2: { not: null } }],
      },
    }),
  ]);

  const registros: RegistroComFotoDTO[] = movimentacao.map((item) => ({
    origem: 'movimentacao',
    chave: item.chave,
    numeroContagem: item.numeroContagem,
    descricao: item.descricao,
    local: item.local,
    quantidadeConferida: item.quantidadeConferida,
    conferidoPorId: item.conferidoPorId,
    dataConferencia: item.dataConferencia.toISOString(),
  }));

  function dentroDoPeriodo(data: Date): boolean {
    if (filtro.dataInicio && data < filtro.dataInicio) return false;
    if (filtro.dataFim && data > filtro.dataFim) return false;
    return true;
  }

  for (const item of contagem) {
    if (item.fotoChaveArmazenamento && item.dataConferencia && dentroDoPeriodo(item.dataConferencia)) {
      registros.push({
        origem: 'contagem',
        chave: item.id,
        numeroContagem: 1,
        descricao: item.descricao,
        local: item.local,
        quantidadeConferida: item.quantidadeConferida ?? 0,
        conferidoPorId: item.conferidoPorId ?? item.iniciadoPorId ?? '',
        dataConferencia: item.dataConferencia.toISOString(),
      });
    }
    if (item.fotoChaveArmazenamento2 && item.dataConferencia2 && dentroDoPeriodo(item.dataConferencia2)) {
      registros.push({
        origem: 'contagem',
        chave: item.id,
        numeroContagem: 2,
        descricao: item.descricao,
        local: item.local,
        quantidadeConferida: item.quantidadeConferida2 ?? 0,
        conferidoPorId: item.conferidoPor2Id ?? item.iniciadoPorId ?? '',
        dataConferencia: item.dataConferencia2.toISOString(),
      });
    }
  }

  registros.sort((a, b) => new Date(b.dataConferencia).getTime() - new Date(a.dataConferencia).getTime());
  return registros;
}

function estilizarCabecalho(sheet: ExcelJS.Worksheet): void {
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF024742' } };
}

export async function gerarHistoricoExcel(filtro: FiltroHistorico): Promise<ExcelJS.Buffer> {
  const resumo = await getHistoricoContagem(filtro);

  const workbook = new ExcelJS.Workbook();

  const resumoSheet = workbook.addWorksheet('Resumo por operador');
  resumoSheet.columns = [
    { header: 'Operador', key: 'nome', width: 28 },
    { header: 'Conferências', key: 'totalConferencias', width: 14 },
    { header: 'Itens conferidos', key: 'totalItens', width: 16 },
    { header: 'Divergências', key: 'totalDivergencias', width: 14 },
  ];
  estilizarCabecalho(resumoSheet);
  resumo.ranking.forEach((r) => resumoSheet.addRow(r));

  const sheet = workbook.addWorksheet('Histórico de conferências');
  sheet.columns = [
    { header: 'Nota', key: 'nota', width: 12 },
    { header: 'Empresa', key: 'empresa', width: 14 },
    { header: 'Tipo', key: 'tipo', width: 10 },
    { header: 'Parceiro', key: 'parceiro', width: 28 },
    { header: 'Operador', key: 'operador', width: 24 },
    { header: 'Data da conferência', key: 'data', width: 20 },
    { header: 'Itens conferidos', key: 'totalItens', width: 16 },
    { header: 'Divergências', key: 'totalDivergencias', width: 14 },
  ];
  estilizarCabecalho(sheet);
  resumo.conferencias.forEach((c) =>
    sheet.addRow({
      nota: c.numeroNota,
      empresa: c.empresaCodigo,
      tipo: c.tipo === 'ENTRADA' ? 'Entrada' : 'Saída',
      parceiro: c.parceiro,
      operador: c.conferidoPorNome,
      data: new Date(c.dataConferencia).toLocaleString('pt-BR'),
      totalItens: c.totalItens,
      totalDivergencias: c.totalDivergencias,
    })
  );

  return workbook.xlsx.writeBuffer();
}

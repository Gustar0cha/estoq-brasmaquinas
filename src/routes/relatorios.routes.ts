import { Router } from 'express';

import { autenticar, exigirAdmin } from '../middleware/auth';
import {
  gerarRelatorioContagemExcel,
  gerarRelatorioExcel,
  gerarRelatorioSistemaVsContadoExcel,
  gerarRelatorioComparativoCiclosExcel,
} from '../services/relatorios.service';
import { StatusConferencia } from '../services/movimentacoes.service';
import { TipoMovimentacaoSankhya } from '../sankhya/types';

export const relatoriosRouter = Router();

relatoriosRouter.get('/movimentacoes.xlsx', autenticar, exigirAdmin, async (req, res) => {
  const { dataInicio, dataFim, empresaCodigo, tipo, status, atribuidoPara, somenteDivergencias, incluirFotos } =
    req.query;

  try {
    const buffer = await gerarRelatorioExcel({
      dataInicio: typeof dataInicio === 'string' ? new Date(dataInicio) : undefined,
      dataFim: typeof dataFim === 'string' ? new Date(dataFim) : undefined,
      empresaCodigo: typeof empresaCodigo === 'string' ? empresaCodigo : undefined,
      tipo: typeof tipo === 'string' ? (tipo as TipoMovimentacaoSankhya) : undefined,
      status: typeof status === 'string' ? (status as StatusConferencia) : undefined,
      atribuidoPara: typeof atribuidoPara === 'string' ? atribuidoPara : undefined,
      somenteDivergencias: somenteDivergencias === 'true',
      incluirFotos: incluirFotos === 'true',
    });

    const nomeArquivo = somenteDivergencias === 'true' ? 'divergencias.xlsx' : 'movimentacoes.xlsx';
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(buffer);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar o relatório.' });
  }
});

relatoriosRouter.get('/contagem/xlsx', autenticar, exigirAdmin, async (req, res) => {
  const { dataInicio, dataFim, somenteDivergencias, incluirFotos, cicloId } = req.query;

  try {
    const buffer = await gerarRelatorioContagemExcel({
      dataInicio: typeof dataInicio === 'string' ? new Date(dataInicio) : undefined,
      dataFim: typeof dataFim === 'string' ? new Date(dataFim) : undefined,
      somenteDivergencias: somenteDivergencias === 'true',
      incluirFotos: incluirFotos === 'true',
      cicloId: typeof cicloId === 'string' && cicloId ? cicloId : undefined,
    });
    const nomeArquivo = somenteDivergencias === 'true' ? 'contagem-divergencias.xlsx' : 'contagem.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${nomeArquivo}"`);
    res.send(buffer);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar o relatório.' });
  }
});

relatoriosRouter.get('/sistema-vs-contado/xlsx', autenticar, exigirAdmin, async (req, res) => {
  const { dataInicio, dataFim } = req.query;

  try {
    const buffer = await gerarRelatorioSistemaVsContadoExcel({
      dataInicio: typeof dataInicio === 'string' ? new Date(dataInicio) : undefined,
      dataFim: typeof dataFim === 'string' ? new Date(dataFim) : undefined,
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="sistema-vs-contado.xlsx"');
    res.send(buffer);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar o relatório.' });
  }
});

// Uma contagem contra a anterior: o "versus" que antes dependia de alguém
// lembrar as datas exatas de cada inventário.
relatoriosRouter.get('/comparativo-ciclos/xlsx', autenticar, exigirAdmin, async (req, res) => {
  const { cicloAtualId, cicloAnteriorId, somenteMudancas } = req.query;

  if (typeof cicloAtualId !== 'string' || typeof cicloAnteriorId !== 'string') {
    res.status(400).json({ erro: 'Escolha as duas contagens a comparar.' });
    return;
  }
  if (cicloAtualId === cicloAnteriorId) {
    res.status(400).json({ erro: 'Escolha duas contagens diferentes.' });
    return;
  }

  try {
    const buffer = await gerarRelatorioComparativoCiclosExcel({
      cicloAtualId,
      cicloAnteriorId,
      somenteMudancas: somenteMudancas === 'true',
    });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="comparativo-contagens.xlsx"');
    res.send(buffer);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar o relatório.' });
  }
});

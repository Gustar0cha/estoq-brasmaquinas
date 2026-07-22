import { Router } from 'express';

import { autenticar, exigirAdmin } from '../middleware/auth';
import { gerarRelatorioExcel } from '../services/relatorios.service';
import { StatusConferencia } from '../services/movimentacoes.service';
import { TipoMovimentacaoSankhya } from '../sankhya/types';

export const relatoriosRouter = Router();

relatoriosRouter.get('/movimentacoes.xlsx', autenticar, exigirAdmin, async (req, res) => {
  const { dataInicio, dataFim, empresaCodigo, tipo, status, atribuidoPara, somenteDivergencias } =
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

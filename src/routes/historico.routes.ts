import { Router } from 'express';

import { autenticar, exigirAdmin } from '../middleware/auth';
import { gerarHistoricoExcel, getHistoricoContagem } from '../services/historico.service';

export const historicoRouter = Router();

function parseFiltro(query: Record<string, unknown>) {
  const { dataInicio, dataFim, empresaCodigo, usuarioId } = query;
  return {
    dataInicio: typeof dataInicio === 'string' ? new Date(dataInicio) : undefined,
    dataFim: typeof dataFim === 'string' ? new Date(dataFim) : undefined,
    empresaCodigo: typeof empresaCodigo === 'string' ? empresaCodigo : undefined,
    usuarioId: typeof usuarioId === 'string' ? usuarioId : undefined,
  };
}

historicoRouter.get('/', autenticar, exigirAdmin, async (req, res) => {
  res.json(await getHistoricoContagem(parseFiltro(req.query as Record<string, unknown>)));
});

historicoRouter.get('/historico.xlsx', autenticar, exigirAdmin, async (req, res) => {
  try {
    const buffer = await gerarHistoricoExcel(parseFiltro(req.query as Record<string, unknown>));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="historico-contagem.xlsx"');
    res.send(buffer);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar o relatório.' });
  }
});

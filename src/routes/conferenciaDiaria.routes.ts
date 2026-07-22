import { Router } from 'express';

import { autenticar, exigirAdmin } from '../middleware/auth';
import { gerarConferenciaDiariaExcel, getConferenciaDiaria } from '../services/conferenciaDiaria.service';

export const conferenciaDiariaRouter = Router();

function resolverData(query: unknown): Date {
  if (typeof query === 'string' && query) {
    const data = new Date(query);
    if (!Number.isNaN(data.getTime())) return data;
  }
  return new Date();
}

conferenciaDiariaRouter.get('/', autenticar, exigirAdmin, async (req, res) => {
  try {
    const linhas = await getConferenciaDiaria(resolverData(req.query.data));
    res.json(linhas);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar a conferência diária.' });
  }
});

conferenciaDiariaRouter.get('/xlsx', autenticar, exigirAdmin, async (req, res) => {
  try {
    const buffer = await gerarConferenciaDiariaExcel(resolverData(req.query.data));
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', 'attachment; filename="conferencia-diaria.xlsx"');
    res.send(buffer);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar a conferência diária.' });
  }
});

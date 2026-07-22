import { Router } from 'express';

import { autenticar, exigirAdmin } from '../middleware/auth';
import { DiaReferencia, hojeBrasil, parseDiaReferencia } from '../lib/datas';
import {
  gerarConferenciaDiariaExcel,
  getConferenciaDiaria,
  getDetalheConferenciaDiaria,
} from '../services/conferenciaDiaria.service';

export const conferenciaDiariaRouter = Router();

function resolverDiaReferencia(query: unknown): DiaReferencia {
  if (typeof query === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query)) {
    return parseDiaReferencia(query);
  }
  return hojeBrasil();
}

function paramString(valor: unknown): string {
  return typeof valor === 'string' ? valor : '';
}

conferenciaDiariaRouter.get('/', autenticar, exigirAdmin, async (req, res) => {
  try {
    const linhas = await getConferenciaDiaria(resolverDiaReferencia(req.query.data));
    res.json(linhas);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar a conferência diária.' });
  }
});

conferenciaDiariaRouter.get('/xlsx', autenticar, exigirAdmin, async (req, res) => {
  try {
    const buffer = await gerarConferenciaDiariaExcel(resolverDiaReferencia(req.query.data));
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

conferenciaDiariaRouter.get('/detalhe', autenticar, exigirAdmin, async (req, res) => {
  try {
    const diaRef = resolverDiaReferencia(req.query.data);
    const detalhe = await getDetalheConferenciaDiaria(
      diaRef,
      paramString(req.query.empresaCodigo),
      paramString(req.query.codigoProduto),
      paramString(req.query.localCodigo),
      paramString(req.query.empresaNome),
      paramString(req.query.descricao),
      paramString(req.query.local)
    );
    res.json(detalhe);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível gerar o detalhe.' });
  }
});

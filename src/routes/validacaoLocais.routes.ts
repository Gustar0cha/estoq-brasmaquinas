import { Request, Response, Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirGestor, exigirPapel } from '../middleware/auth';
import * as servico from '../services/validacaoLocais.service';
import { ErroValidacao } from '../services/validacaoLocais.service';

// Validar locais — ver services/validacaoLocais.service.ts. Quem bipa:
// contador, gestor e administrador (o visualizador só acompanha).
export const validacaoLocaisRouter = Router();
const exigirQuemValida = exigirPapel('ADMIN', 'GESTOR', 'OPERADOR');

const rota =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (erro) {
      if (erro instanceof ErroValidacao) {
        const status = erro.codigo === 'NAO_ENCONTRADA' ? 404 : erro.codigo === 'NAO_AUTORIZADO' ? 403 : erro.codigo === 'SANKHYA' ? 503 : 400;
        res.status(status).json({ erro: erro.message, codigo: erro.codigo });
        return;
      }
      if (erro instanceof z.ZodError) {
        res.status(400).json({ erro: 'Dados inválidos.' });
        return;
      }
      console.error('[validacao-locais]', erro);
      res.status(500).json({ erro: 'Não foi possível concluir. Tente de novo.' });
    }
  };

const usuarioId = (req: Request) => req.usuario!.sub;
const param = (req: Request, nome: string) => String((req.params as Record<string, string>)[nome]);

const filtro = (req: Request): servico.FiltroValidacao => {
  const data = (v: unknown, fimDoDia = false) => {
    if (typeof v !== 'string' || !v) return undefined;
    const d = new Date(fimDoDia && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999-03:00` : v);
    return Number.isNaN(d.getTime()) ? undefined : d;
  };
  return { de: data(req.query.de), ate: data(req.query.ate, true), somenteForaDoLocal: req.query.fora === 'true' };
};

validacaoLocaisRouter.get('/estado', autenticar, exigirQuemValida, rota(async (req, res) => {
  res.json(await servico.estadoValidacao(usuarioId(req)));
}));

validacaoLocaisRouter.post('/', autenticar, exigirQuemValida, rota(async (req, res) => {
  const { codigoLocal } = z.object({ codigoLocal: z.string().trim().min(1).max(30) }).parse(req.body);
  res.status(201).json(await servico.abrirValidacao(usuarioId(req), codigoLocal));
}));

validacaoLocaisRouter.post('/:id/bipes', autenticar, exigirQuemValida, rota(async (req, res) => {
  const dados = z.object({ codigo: z.string().trim().max(80).optional(), codigoProduto: z.string().trim().max(20).optional() }).parse(req.body);
  res.json(await servico.biparNaValidacao({ usuarioId: usuarioId(req), validacaoId: param(req, 'id'), ...dados }));
}));

validacaoLocaisRouter.post('/:id/finalizar', autenticar, exigirQuemValida, rota(async (req, res) => {
  res.json(await servico.finalizarValidacao(usuarioId(req), param(req, 'id')));
}));

validacaoLocaisRouter.delete('/itens/:itemId', autenticar, exigirQuemValida, rota(async (req, res) => {
  await servico.removerItemValidacao(usuarioId(req), param(req, 'itemId'));
  res.status(204).end();
}));

// Relatório (painel).
validacaoLocaisRouter.get('/', autenticar, exigirGestor, rota(async (req, res) => {
  res.json(await servico.listarValidacoes(filtro(req)));
}));

validacaoLocaisRouter.get('/relatorio.xlsx', autenticar, exigirGestor, rota(async (req, res) => {
  const buffer = await servico.gerarValidacaoXlsx(filtro(req));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="validacao-de-locais.xlsx"');
  res.send(Buffer.from(buffer as ArrayBuffer));
}));

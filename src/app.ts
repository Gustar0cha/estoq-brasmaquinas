import path from 'node:path';

import cors from 'cors';
import express from 'express';

import { env } from './lib/env';

import { appVersaoRouter } from './routes/appVersao.routes';
import { authRouter } from './routes/auth.routes';
import { conferenciaDiariaRouter } from './routes/conferenciaDiaria.routes';
import { cicloRouter } from './routes/ciclo.routes';
import { contagemItensRouter, contagemRouter } from './routes/contagem.routes';
import { dashboardRouter } from './routes/dashboard.routes';
import { divergenciasRouter } from './routes/divergencias.routes';
import { historicoRouter } from './routes/historico.routes';
import { itemConferenciaRouter } from './routes/itemConferencia.routes';
import { movimentacoesRouter } from './routes/movimentacoes.routes';
import { negativadosRouter } from './routes/negativados.routes';
import { notificacoesRouter } from './routes/notificacoes.routes';
import { relatoriosRouter } from './routes/relatorios.routes';
import { usuariosRouter } from './routes/usuarios.routes';

export const app = express();

// CORS restrito a origens conhecidas.
//
// Devolver `false` (em vez de lançar erro) é proposital: assim o servidor
// simplesmente não manda o cabeçalho Access-Control-Allow-Origin e o próprio
// navegador barra a chamada de outra origem. Lançar erro aqui viraria um 500
// até em requisição same-origin do painel, que manda cabeçalho Origin em POST
// mas não precisa de CORS nenhum.
//
// Requisição sem Origin (app no celular, curl, health check) segue liberada:
// CORS é uma proteção de navegador e não se aplica a elas.
app.use(
  cors({
    origin: (origem, callback) =>
      callback(null, !origem || env.origensPermitidas.includes(origem)),
  })
);
app.use(express.json());

// Painel web (build estático do mesmo app Expo) servido pelo próprio backend,
// no mesmo domínio da API — o que torna as chamadas do painel same-origin.
// Gerado com `npm run build:painel` no repositório do app.
const PASTA_PAINEL = path.resolve(__dirname, '..', 'public', 'painel');

app.use('/painel', express.static(PASTA_PAINEL));
// SPA: qualquer rota interna (/painel/admin/relatorios) devolve o index.html
// e o roteamento acontece no navegador. Usa `use` em vez de um curinga de
// rota porque o Express 5 mudou a sintaxe de wildcard.
app.use('/painel', (_req, res) => res.sendFile(path.join(PASTA_PAINEL, 'index.html')));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRouter);
app.use('/usuarios', usuariosRouter);
app.use('/movimentacoes', movimentacoesRouter);
app.use('/item-conferencia', itemConferenciaRouter);
app.use('/notificacoes', notificacoesRouter);
app.use('/divergencias', divergenciasRouter);
app.use('/relatorios', relatoriosRouter);
app.use('/conferencia-diaria', conferenciaDiariaRouter);
app.use('/historico-contagem', historicoRouter);
app.use('/dashboard', dashboardRouter);
app.use('/ciclos', cicloRouter);
app.use('/contagem', contagemRouter);
app.use('/contagem-itens', contagemItensRouter);
app.use('/produtos-negativados', negativadosRouter);
app.use('/app/versao', appVersaoRouter);

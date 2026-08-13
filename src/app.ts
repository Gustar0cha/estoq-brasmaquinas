import cors from 'cors';
import express from 'express';

import { authRouter } from './routes/auth.routes';
import { conferenciaDiariaRouter } from './routes/conferenciaDiaria.routes';
import { contagemItensRouter, contagemRouter } from './routes/contagem.routes';
import { divergenciasRouter } from './routes/divergencias.routes';
import { historicoRouter } from './routes/historico.routes';
import { itemConferenciaRouter } from './routes/itemConferencia.routes';
import { movimentacoesRouter } from './routes/movimentacoes.routes';
import { notificacoesRouter } from './routes/notificacoes.routes';
import { relatoriosRouter } from './routes/relatorios.routes';
import { usuariosRouter } from './routes/usuarios.routes';

export const app = express();

app.use(cors());
app.use(express.json());

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
app.use('/contagem', contagemRouter);
app.use('/contagem-itens', contagemItensRouter);

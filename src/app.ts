import cors from 'cors';
import express from 'express';

import { authRouter } from './routes/auth.routes';
import { divergenciasRouter } from './routes/divergencias.routes';
import { movimentacoesRouter } from './routes/movimentacoes.routes';
import { relatoriosRouter } from './routes/relatorios.routes';
import { usuariosRouter } from './routes/usuarios.routes';

export const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ ok: true }));

app.use('/auth', authRouter);
app.use('/usuarios', usuariosRouter);
app.use('/movimentacoes', movimentacoesRouter);
app.use('/divergencias', divergenciasRouter);
app.use('/relatorios', relatoriosRouter);

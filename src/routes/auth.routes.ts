import { Router } from 'express';
import { z } from 'zod';

import * as authService from '../services/auth.service';

export const authRouter = Router();

const loginSchema = z.object({
  login: z.string().min(1),
  senha: z.string().min(1),
});

authRouter.post('/login', async (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Login e senha são obrigatórios.' });
    return;
  }

  try {
    const resultado = await authService.login(parse.data.login, parse.data.senha);
    res.json(resultado);
  } catch (error) {
    res.status(401).json({ erro: error instanceof Error ? error.message : 'Não foi possível entrar.' });
  }
});

authRouter.post('/logout', (_req, res) => {
  // Autenticação é stateless (JWT) — não há sessão no servidor para invalidar.
  res.json({ ok: true });
});

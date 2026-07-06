import { NextFunction, Request, Response } from 'express';

import { TokenPayload, verificarToken } from '../lib/jwt';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: TokenPayload;
    }
  }
}

export function autenticar(req: Request, res: Response, next: NextFunction) {
  const cabecalho = req.headers.authorization;
  const token = cabecalho?.startsWith('Bearer ') ? cabecalho.slice('Bearer '.length) : null;

  if (!token) {
    res.status(401).json({ erro: 'Token de autenticação ausente.' });
    return;
  }

  try {
    req.usuario = verificarToken(token);
    next();
  } catch {
    res.status(401).json({ erro: 'Token de autenticação inválido ou expirado.' });
  }
}

export function exigirAdmin(req: Request, res: Response, next: NextFunction) {
  if (req.usuario?.role !== 'ADMIN') {
    res.status(403).json({ erro: 'Ação restrita a administradores.' });
    return;
  }
  next();
}

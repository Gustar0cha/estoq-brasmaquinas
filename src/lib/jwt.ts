import jwt from 'jsonwebtoken';

import { env } from './env';
import { PapelUsuario } from '../generated/prisma/client';

export interface TokenPayload {
  sub: string;
  role: PapelUsuario;
}

export function assinarToken(payload: TokenPayload): string {
  return jwt.sign(payload, env.jwtSecret, { expiresIn: env.jwtExpiresIn as jwt.SignOptions['expiresIn'] });
}

export function verificarToken(token: string): TokenPayload {
  return jwt.verify(token, env.jwtSecret) as TokenPayload;
}

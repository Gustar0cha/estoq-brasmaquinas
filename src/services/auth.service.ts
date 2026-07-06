import { assinarToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { conferirHash } from '../lib/senha';

export interface LoginResultado {
  token: string;
  usuario: { id: string; nome: string; login: string; role: 'ADMIN' | 'OPERADOR' };
}

export async function login(login: string, senha: string): Promise<LoginResultado> {
  const usuario = await prisma.usuario.findUnique({ where: { login } });
  if (!usuario) {
    throw new Error('Login ou senha inválidos');
  }

  const senhaValida = await conferirHash(senha, usuario.senhaHash);
  if (!senhaValida) {
    throw new Error('Login ou senha inválidos');
  }

  const token = assinarToken({ sub: usuario.id, role: usuario.role });

  return {
    token,
    usuario: { id: usuario.id, nome: usuario.nome, login: usuario.login, role: usuario.role },
  };
}

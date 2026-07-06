import { prisma } from '../lib/prisma';
import { gerarHash } from '../lib/senha';
import type { PapelUsuario, Usuario as UsuarioPrisma } from '../generated/prisma/client';

function semSenha(usuario: UsuarioPrisma) {
  return { id: usuario.id, nome: usuario.nome, login: usuario.login, role: usuario.role };
}

export async function getUsuarios() {
  const usuarios = await prisma.usuario.findMany({ orderBy: { nome: 'asc' } });
  return usuarios.map(semSenha);
}

export async function getOperadores() {
  const usuarios = await prisma.usuario.findMany({
    where: { role: 'OPERADOR' },
    orderBy: { nome: 'asc' },
  });
  return usuarios.map(semSenha);
}

export interface CriarUsuarioInput {
  nome: string;
  login: string;
  senha: string;
  role: PapelUsuario;
}

export async function criarUsuario(input: CriarUsuarioInput) {
  const loginExistente = await prisma.usuario.findUnique({ where: { login: input.login } });
  if (loginExistente) {
    throw new Error(`Já existe um usuário com o login "${input.login}".`);
  }

  const senhaHash = await gerarHash(input.senha);
  const usuario = await prisma.usuario.create({
    data: { nome: input.nome, login: input.login, senhaHash, role: input.role },
  });

  return semSenha(usuario);
}

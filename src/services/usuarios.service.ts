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

export interface AtualizarUsuarioInput {
  login?: string;
  senha?: string;
  role?: PapelUsuario;
}

// O nome não é editável de propósito — só login, senha e papel.
export async function atualizarUsuario(id: string, input: AtualizarUsuarioInput) {
  const usuarioExistente = await prisma.usuario.findUnique({ where: { id } });
  if (!usuarioExistente) {
    throw new Error('Usuário não encontrado.');
  }

  const dados: { login?: string; senhaHash?: string; role?: PapelUsuario } = {};

  if (input.login && input.login !== usuarioExistente.login) {
    const loginEmUso = await prisma.usuario.findUnique({ where: { login: input.login } });
    if (loginEmUso) {
      throw new Error(`Já existe um usuário com o login "${input.login}".`);
    }
    dados.login = input.login;
  }

  if (input.senha) {
    dados.senhaHash = await gerarHash(input.senha);
  }

  if (input.role) {
    dados.role = input.role;
  }

  const usuario = await prisma.usuario.update({ where: { id }, data: dados });
  return semSenha(usuario);
}

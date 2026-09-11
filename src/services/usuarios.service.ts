import { ehFilial } from '../lib/filiais';
import { prisma } from '../lib/prisma';
import { gerarHash } from '../lib/senha';
import type { PapelUsuario, Usuario as UsuarioPrisma } from '../generated/prisma/client';

function semSenha(usuario: UsuarioPrisma) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    login: usuario.login,
    role: usuario.role,
    filial: usuario.filial ?? null,
  };
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
  // Loja do usuário (ver src/lib/filiais.ts); null = enxerga todas as lojas.
  filial?: string | null;
}

export async function criarUsuario(input: CriarUsuarioInput) {
  const loginExistente = await prisma.usuario.findUnique({ where: { login: input.login } });
  if (loginExistente) {
    throw new Error(`Já existe um usuário com o login "${input.login}".`);
  }

  const senhaHash = await gerarHash(input.senha);
  const usuario = await prisma.usuario.create({
    data: {
      nome: input.nome,
      login: input.login,
      senhaHash,
      role: input.role,
      filial: ehFilial(input.filial) ? input.filial : null,
    },
  });

  return semSenha(usuario);
}

export interface AtualizarUsuarioInput {
  login?: string;
  senha?: string;
  role?: PapelUsuario;
  // null limpa a filial (volta a enxergar todas as lojas); undefined mantém.
  filial?: string | null;
}

// O nome não é editável de propósito — só login, senha e papel.
export async function atualizarUsuario(id: string, input: AtualizarUsuarioInput) {
  const usuarioExistente = await prisma.usuario.findUnique({ where: { id } });
  if (!usuarioExistente) {
    throw new Error('Usuário não encontrado.');
  }

  const dados: { login?: string; senhaHash?: string; role?: PapelUsuario; filial?: string | null } = {};

  if (input.filial !== undefined) {
    dados.filial = ehFilial(input.filial) ? input.filial : null;
  }

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

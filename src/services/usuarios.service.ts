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

// Só quem está ativo recebe tarefa: login desativado não pode aparecer na
// lista de quem vai contar.
export async function getOperadores() {
  const usuarios = await prisma.usuario.findMany({
    where: { role: 'OPERADOR', ativo: true },
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
  // Nome passou a ser editável: login criado com nome errado era corrigido
  // apagando e recriando, o que levava o histórico junto.
  nome?: string;
  ativo?: boolean;
}

export async function atualizarUsuario(id: string, input: AtualizarUsuarioInput) {
  const usuarioExistente = await prisma.usuario.findUnique({ where: { id } });
  if (!usuarioExistente) {
    throw new Error('Usuário não encontrado.');
  }

  const dados: {
    login?: string;
    senhaHash?: string;
    role?: PapelUsuario;
    filial?: string | null;
    nome?: string;
    ativo?: boolean;
  } = {};

  if (input.nome !== undefined && input.nome.trim()) dados.nome = input.nome.trim();
  if (input.ativo !== undefined) dados.ativo = input.ativo;

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

// Quantos registros dependem deste usuário. É o que decide entre apagar de
// verdade e desativar: quem já contou alguma coisa não pode sumir sem levar o
// histórico junto.
export async function vinculosDoUsuario(id: string): Promise<number> {
  const [contagens, conferencias, atribuicoes, tarefas, responsavel] = await Promise.all([
    prisma.contagemItem.count({
      where: { OR: [{ atribuidoParaId: id }, { conferidoPorId: id }, { iniciadoPorId: id }] },
    }),
    prisma.itemConferenciaResultado.count({ where: { conferidoPorId: id } }),
    prisma.itemAtribuicao.count({ where: { usuarioId: id } }),
    prisma.tarefa.count({ where: { criadaPorId: id } }),
    prisma.tarefaResponsavel.count({ where: { usuarioId: id } }),
  ]);
  return contagens + conferencias + atribuicoes + tarefas + responsavel;
}

export async function apagarUsuario(id: string): Promise<{ apagado: boolean; vinculos: number }> {
  const vinculos = await vinculosDoUsuario(id);
  if (vinculos > 0) {
    // Não apaga: desativa. O login para de entrar e some das atribuições,
    // mas tudo que a pessoa contou continua no relatório com o nome dela.
    await prisma.usuario.update({ where: { id }, data: { ativo: false } });
    return { apagado: false, vinculos };
  }
  await prisma.notificacaoPreferencia.deleteMany({ where: { usuarioId: id } });
  await prisma.notificacao.deleteMany({ where: { usuarioId: id } });
  await prisma.usuario.delete({ where: { id } });
  return { apagado: true, vinculos: 0 };
}

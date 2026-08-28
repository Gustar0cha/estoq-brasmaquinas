import { prisma } from '../lib/prisma';

export interface NotificacaoDTO {
  id: string;
  tipo: string;
  chave: string;
  titulo: string;
  mensagem: string;
  lida: boolean;
  criadoEm: string;
}

// Catálogo dos tipos configuráveis em Configurações — a UI usa isso pra
// listar as opções, sem precisar saber os literais usados no código.
export const TIPOS_NOTIFICACAO: { tipo: string; label: string }[] = [
  { tipo: 'DIVERGENCIA', label: 'Divergência na conferência por movimentação' },
  { tipo: 'INICIO_CONTAGEM', label: 'Início de contagem' },
  { tipo: 'FIM_CONTAGEM', label: 'Fim de contagem (bateu certo)' },
  { tipo: 'DIVERGENCIA_CONTAGEM', label: 'Divergência na contagem' },
  { tipo: 'INICIO_SEGUNDA_CONTAGEM', label: 'Início de recontagem' },
  { tipo: 'PRODUTO_NEGATIVADO', label: 'Produto com estoque negativo' },
];

// Central de criação de notificações — todo lugar do backend que precisa
// avisar alguém passa por aqui, nunca cria a linha direto no Prisma. Sem
// NotificacaoPreferencia configurada pro tipo, o padrão (de sempre) é uma
// linha "pra todos os admins" (usuarioId null); com preferência configurada,
// cria uma linha por destinatário escolhido — pode incluir operadores.
export async function criarNotificacao(
  tipo: string,
  chave: string,
  titulo: string,
  mensagem: string
): Promise<void> {
  const preferencias = await prisma.notificacaoPreferencia.findMany({ where: { tipo } });

  if (preferencias.length === 0) {
    await prisma.notificacao.create({ data: { tipo, chave, titulo, mensagem, usuarioId: null } });
    return;
  }

  await prisma.notificacao.createMany({
    data: preferencias.map((p) => ({ tipo, chave, titulo, mensagem, usuarioId: p.usuarioId })),
  });
}

// Pra avisos que são sempre pra UMA pessoa específica (ex: "você recebeu uma
// atribuição de contagem") — não passa pela resolução de preferência, porque
// não é um tipo de alerta configurável pelo admin, é uma mensagem direta.
export async function notificarUsuario(
  tipo: string,
  chave: string,
  titulo: string,
  mensagem: string,
  usuarioId: string
): Promise<void> {
  await prisma.notificacao.create({ data: { tipo, chave, titulo, mensagem, usuarioId } });
}

// Admin sempre vê as notificações "padrão" (usuarioId null) além das suas
// próprias; um operador só vê o que foi explicitamente configurado pra ele.
export async function getNotificacoes(usuarioId: string, isAdmin: boolean): Promise<NotificacaoDTO[]> {
  const notificacoes = await prisma.notificacao.findMany({
    where: { OR: [{ usuarioId }, ...(isAdmin ? [{ usuarioId: null }] : [])] },
    orderBy: { criadoEm: 'desc' },
    take: 100,
  });

  return notificacoes.map((n) => ({
    id: n.id,
    tipo: n.tipo,
    chave: n.chave,
    titulo: n.titulo,
    mensagem: n.mensagem,
    lida: n.lida,
    criadoEm: n.criadoEm.toISOString(),
  }));
}

export async function marcarNotificacaoLida(id: string): Promise<void> {
  await prisma.notificacao.update({ where: { id }, data: { lida: true } });
}

export interface PreferenciaNotificacaoDTO {
  tipo: string;
  usuarioIds: string[];
}

export async function getPreferenciasNotificacao(): Promise<PreferenciaNotificacaoDTO[]> {
  const preferencias = await prisma.notificacaoPreferencia.findMany();
  const porTipo = new Map<string, string[]>();
  for (const p of preferencias) {
    porTipo.set(p.tipo, [...(porTipo.get(p.tipo) ?? []), p.usuarioId]);
  }
  return TIPOS_NOTIFICACAO.map(({ tipo }) => ({ tipo, usuarioIds: porTipo.get(tipo) ?? [] }));
}

// Substitui a lista inteira de destinatários daquele tipo. Lista vazia =
// volta pro padrão (todos os admins).
export async function definirPreferenciaNotificacao(tipo: string, usuarioIds: string[]): Promise<void> {
  await prisma.$transaction([
    prisma.notificacaoPreferencia.deleteMany({ where: { tipo } }),
    ...(usuarioIds.length > 0
      ? [prisma.notificacaoPreferencia.createMany({ data: usuarioIds.map((usuarioId) => ({ tipo, usuarioId })) })]
      : []),
  ]);
}

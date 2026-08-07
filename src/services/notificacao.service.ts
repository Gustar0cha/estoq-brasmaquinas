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

export async function getNotificacoes(): Promise<NotificacaoDTO[]> {
  const notificacoes = await prisma.notificacao.findMany({ orderBy: { criadoEm: 'desc' }, take: 100 });
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

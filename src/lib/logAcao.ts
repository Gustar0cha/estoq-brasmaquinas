import { prisma } from './prisma';

// Trilha de ações (Configurações → Logs). Responde "quem fez isso?": quem
// desligou uma trava, excluiu uma contagem, mandou item pra quarentena,
// apagou um registro.
//
// Gravar log nunca pode derrubar a ação que ele descreve: falhou, segue.
export type AcaoLog =
  | 'LOGIN'
  | 'USUARIO_CRIADO'
  | 'USUARIO_EDITADO'
  | 'USUARIO_EXCLUIDO'
  | 'CONTAGEM_CRIADA'
  | 'CONTAGEM_CONFIGURADA'
  | 'CONTAGEM_ENCERRADA'
  | 'CONTAGEM_EXCLUIDA'
  | 'LOCAL_ABERTO'
  | 'LOCAL_FINALIZADO'
  | 'ITEM_REGISTRADO'
  | 'ITEM_APAGADO'
  | 'RECONTAGEM_PEDIDA'
  | 'QUARENTENA'
  | 'LOCAL_IGNORADO'
  | 'LOCAL_REATIVADO'
  | 'DADOS_LIMPOS';

export async function registrarLog(
  usuarioId: string | null,
  acao: AcaoLog,
  descricao: string,
  detalhes?: Record<string, unknown>
): Promise<void> {
  try {
    const usuario = usuarioId
      ? await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { nome: true } })
      : null;
    await prisma.logAcao.create({
      data: {
        usuarioId: usuario ? usuarioId : null,
        usuarioNome: usuario?.nome ?? 'Sistema',
        acao,
        descricao,
        detalhes: detalhes ? JSON.parse(JSON.stringify(detalhes)) : undefined,
      },
    });
  } catch (erro) {
    console.warn('[log] não gravou', acao, erro instanceof Error ? erro.message : erro);
  }
}

export interface FiltroLogs {
  usuarioId?: string;
  acoes?: string[];
  de?: Date;
  ate?: Date;
  busca?: string;
  pagina?: number;
}

export async function listarLogs(filtro: FiltroLogs) {
  const POR_PAGINA = 100;
  const pagina = Math.max(1, filtro.pagina ?? 1);
  const where = {
    ...(filtro.usuarioId ? { usuarioId: filtro.usuarioId } : {}),
    ...(filtro.acoes?.length ? { acao: { in: filtro.acoes } } : {}),
    ...(filtro.de || filtro.ate ? { criadoEm: { ...(filtro.de ? { gte: filtro.de } : {}), ...(filtro.ate ? { lte: filtro.ate } : {}) } } : {}),
    ...(filtro.busca?.trim()
      ? {
          OR: [
            { descricao: { contains: filtro.busca.trim(), mode: 'insensitive' as const } },
            { usuarioNome: { contains: filtro.busca.trim(), mode: 'insensitive' as const } },
          ],
        }
      : {}),
  };
  const [total, itens] = await Promise.all([
    prisma.logAcao.count({ where }),
    prisma.logAcao.findMany({ where, orderBy: { criadoEm: 'desc' }, skip: (pagina - 1) * POR_PAGINA, take: POR_PAGINA }),
  ]);
  return {
    total,
    pagina,
    paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
    itens: itens.map((l) => ({
      id: l.id,
      usuarioId: l.usuarioId,
      usuarioNome: l.usuarioNome,
      acao: l.acao,
      descricao: l.descricao,
      detalhes: l.detalhes,
      criadoEm: l.criadoEm.toISOString(),
    })),
  };
}

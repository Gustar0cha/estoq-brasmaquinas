import { NextFunction, Request, Response } from 'express';

import { TokenPayload, verificarToken } from '../lib/jwt';
import { prisma } from '../lib/prisma';
import { PapelUsuario } from '../generated/prisma/client';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      usuario?: TokenPayload;
    }
  }
}

// O perfil vale o que está no banco, não o que veio no token: tirar o
// administrador de alguém (ou desativar o login) tem efeito em segundos, e
// não só quando o token de 12h vencer. Guardado 30s pra não consultar o
// banco a cada bipe.
const VALIDADE_MS = 30_000;
const perfis = new Map<string, { role: PapelUsuario; ativo: boolean; ate: number }>();

async function perfilAtual(id: string) {
  const guardado = perfis.get(id);
  if (guardado && guardado.ate > Date.now()) return guardado;
  const u = await prisma.usuario.findUnique({ where: { id }, select: { role: true, ativo: true } });
  const novo = { role: u?.role ?? ('OPERADOR' as PapelUsuario), ativo: !!u?.ativo, ate: Date.now() + VALIDADE_MS };
  perfis.set(id, novo);
  return novo;
}

// Quem altera um usuário chama isto: a mudança vale já na próxima chamada.
export function esquecerPerfil(id: string) {
  perfis.delete(id);
}

export async function autenticar(req: Request, res: Response, next: NextFunction) {
  const cabecalho = req.headers.authorization;
  const token = cabecalho?.startsWith('Bearer ') ? cabecalho.slice('Bearer '.length) : null;

  if (!token) {
    res.status(401).json({ erro: 'Token de autenticação ausente.' });
    return;
  }

  let payload: TokenPayload;
  try {
    payload = verificarToken(token);
  } catch {
    res.status(401).json({ erro: 'Token de autenticação inválido ou expirado.' });
    return;
  }

  try {
    const perfil = await perfilAtual(payload.sub);
    if (!perfil.ativo) {
      res.status(401).json({ erro: 'Esse login está desativado. Procure o gestor do estoque.' });
      return;
    }
    req.usuario = { ...payload, role: perfil.role };
    next();
  } catch (erro) {
    next(erro);
  }
}

const NOMES: Record<PapelUsuario, string> = {
  ADMIN: 'administradores',
  GESTOR: 'gestores',
  OPERADOR: 'contadores',
  VISUALIZADOR: 'visualizadores',
};

export function exigirPapel(...papeis: PapelUsuario[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.usuario || !papeis.includes(req.usuario.role)) {
      res.status(403).json({ erro: `Ação restrita a ${papeis.map((p) => NOMES[p]).join(' e ')}.`, codigo: 'SEM_PERMISSAO' });
      return;
    }
    next();
  };
}

// Níveis de acesso (chamado #303):
//   exigirAdmin    criar, editar, encerrar, excluir, configurar, equipe
//   exigirGestor   relatórios, fotos, recontagem, autorizar reabertura
//   exigirLeitura  KPIs (Visão geral, modo TV)
//   exigirContador registrar contagem no celular
export const exigirAdmin = exigirPapel('ADMIN');
export const exigirGestor = exigirPapel('ADMIN', 'GESTOR');
export const exigirLeitura = exigirPapel('ADMIN', 'GESTOR', 'VISUALIZADOR');
export const exigirContador = exigirPapel('ADMIN', 'OPERADOR');

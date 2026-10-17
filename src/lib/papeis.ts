import { PapelUsuario } from '../generated/prisma/client';

// Como cada perfil aparece em logs e mensagens (chamado #303).
export const NOME_PAPEL: Record<PapelUsuario, string> = {
  ADMIN: 'administrador',
  GESTOR: 'gestor',
  OPERADOR: 'contador',
  VISUALIZADOR: 'visualizador',
};

export const nomePapel = (papel: PapelUsuario) => NOME_PAPEL[papel] ?? papel;

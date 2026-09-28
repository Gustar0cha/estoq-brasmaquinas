import { prisma } from '../lib/prisma';

export interface ProjetoDTO {
  id: string;
  nome: string;
  criadoEm: string;
  totalTarefas: number;
}

function dto(projeto: { id: string; nome: string; criadoEm: Date; _count: { tarefas: number } }): ProjetoDTO {
  return {
    id: projeto.id,
    nome: projeto.nome,
    criadoEm: projeto.criadoEm.toISOString(),
    totalTarefas: projeto._count.tarefas,
  };
}

export async function getProjetos(): Promise<ProjetoDTO[]> {
  const projetos = await prisma.projeto.findMany({
    include: { _count: { select: { tarefas: true } } },
    orderBy: { criadoEm: 'desc' },
  });
  return projetos.map(dto);
}

export async function criarProjeto(nome: string): Promise<ProjetoDTO> {
  const projeto = await prisma.projeto.create({
    data: { nome: nome.trim() },
    include: { _count: { select: { tarefas: true } } },
  });
  return dto(projeto);
}

export async function renomearProjeto(id: string, nome: string): Promise<ProjetoDTO> {
  const projeto = await prisma.projeto.update({
    where: { id },
    data: { nome: nome.trim() },
    include: { _count: { select: { tarefas: true } } },
  });
  return dto(projeto);
}

export async function apagarProjeto(id: string): Promise<void> {
  // A FK usa SET NULL: apagar a etiqueta nunca pode apagar/descolar os itens
  // operacionais das tarefas que já foram executadas.
  await prisma.projeto.delete({ where: { id } });
}

import ExcelJS from 'exceljs';

import { empresaDaFilial, filialDoLocal, labelFilial, localVisivelPara } from '../lib/filiais';
import { validarFotoContagem } from '../lib/fotoContagem';
import { obterFotoStream, removerFotoContagem, uploadFotoContagem } from '../lib/minio';
import { prisma } from '../lib/prisma';
import {
  buscarProdutosSankhya,
  chaveReserva,
  ehLocalDeQuarentena,
  getReservadosSankhya,
} from '../sankhya/client';
import { getCustosDaCopia, getLocalSankhya, getRetratoCopia, listarCopiasEstoque } from '../sankhya/copiaEstoque';
import { resolverProdutoDoBipe } from './contagem.service';

// Contagem livre (01/10/2026).
//
// O gestor escolhe uma cópia de estoque do Sankhya e a equipe conta contra
// ela. Ninguém recebe lista: o colaborador bipa a etiqueta do local, bipa os
// produtos que acha ali, registra e finaliza o local. As travas (produto tem
// que estar no local; o mesmo produto no mesmo local só uma vez) e a foto são
// ligadas e desligadas pelo gestor, por contagem.
//
// A 2ª contagem nasce de um pedido do gestor e é feita por outra pessoa.

export class ErroContagemLivre extends Error {
  constructor(
    mensagem: string,
    readonly codigo = 'INVALIDO',
    readonly detalhes?: Record<string, unknown>
  ) {
    super(mensagem);
  }
}

// Conferido na TSIEMP em 01/10/2026. Só pra exibir: a regra usa o código.
const NOME_EMPRESA: Record<string, string> = {
  '1': 'Guanambi',
  '2': 'Lapa',
  '3': 'LEM',
  '4': 'Janaúba',
};

function nomeEmpresa(codigo: string): string {
  return NOME_EMPRESA[codigo] ?? `Empresa ${codigo}`;
}

// PREPARANDO parado há mais que isso é processo que morreu no meio (deploy,
// queda do servidor): a cópia nunca vai terminar sozinha.
const PREPARO_EXPIRA_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Datas da cópia
// ---------------------------------------------------------------------------

// DTCONTAGEM é relógio de parede, sem fuso (ver sankhya/copiaEstoque.ts).
// Guardado como se fosse UTC e lido de volta com os getters UTC.
function dataCopiaParaBanco(dataCopia: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dataCopia)) {
    throw new ErroContagemLivre('Data da cópia inválida.');
  }
  return new Date(`${dataCopia}Z`);
}

function dataCopiaParaSankhya(data: Date): string {
  return data.toISOString().slice(0, 19);
}

const dois = (n: number) => String(n).padStart(2, '0');

export function rotuloCopia(data: Date): string {
  const dia = `${dois(data.getUTCDate())}/${dois(data.getUTCMonth() + 1)}/${data.getUTCFullYear()}`;
  const temHora = data.getUTCHours() !== 0 || data.getUTCMinutes() !== 0;
  return `Cópia Estoque Dia ${dia}${temHora ? ` às ${dois(data.getUTCHours())}:${dois(data.getUTCMinutes())}` : ''}`;
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface ContagemLivreDTO {
  id: string;
  nome: string;
  dataCopia: string;
  rotuloCopia: string;
  empresas: { codigo: string; nome: string }[];
  status: 'PREPARANDO' | 'ATIVA' | 'ENCERRADA' | 'ERRO';
  erro: string | null;
  fotoObrigatoria: boolean;
  travaLocal: boolean;
  travaDuplicada: boolean;
  criadaEm: string;
  encerradaEm: string | null;
}

export interface ResumoContagemLivre {
  itensNaCopia: number;
  locaisNaCopia: number;
  registros: number;
  locaisFinalizados: number;
  recontagensPendentes: number;
}

type LinhaContagem = Awaited<ReturnType<typeof prisma.contagemLivre.findUniqueOrThrow>>;

function statusEfetivo(c: LinhaContagem): ContagemLivreDTO['status'] {
  if (c.status === 'PREPARANDO' && Date.now() - c.criadaEm.getTime() > PREPARO_EXPIRA_MS) return 'ERRO';
  return c.status as ContagemLivreDTO['status'];
}

function montarContagem(c: LinhaContagem): ContagemLivreDTO {
  const status = statusEfetivo(c);
  return {
    id: c.id,
    nome: c.nome,
    dataCopia: dataCopiaParaSankhya(c.dataCopia),
    rotuloCopia: rotuloCopia(c.dataCopia),
    empresas: c.empresas.map((codigo) => ({ codigo, nome: nomeEmpresa(codigo) })),
    status,
    erro: status === 'ERRO' ? c.erro ?? 'A preparação foi interrompida. Tente de novo.' : null,
    fotoObrigatoria: c.fotoObrigatoria,
    travaLocal: c.travaLocal,
    travaDuplicada: c.travaDuplicada,
    criadaEm: c.criadaEm.toISOString(),
    encerradaEm: c.encerradaEm?.toISOString() ?? null,
  };
}

export interface RegistroLivreDTO {
  id: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  localCodigo: string;
  local: string;
  quantidade: number;
  foraDoLocal: boolean;
  numeroContagem: number;
  registradoEm: string;
  // Dá pra apagar enquanto o local não foi finalizado — é a correção de quem
  // digitou errado, já que a trava de duplicidade não deixa contar de novo.
  podeApagar: boolean;
}

type LinhaRegistro = Awaited<ReturnType<typeof prisma.contagemLivreRegistro.findUniqueOrThrow>>;

function montarRegistro(r: LinhaRegistro, sessaoAberta: boolean): RegistroLivreDTO {
  return {
    id: r.id,
    codigoProduto: r.codigoProduto,
    descricao: r.descricao,
    unidade: r.unidade,
    localCodigo: r.localCodigo,
    local: r.local,
    quantidade: r.quantidade,
    foraDoLocal: r.foraDoLocal,
    numeroContagem: r.numeroContagem,
    registradoEm: r.registradoEm.toISOString(),
    podeApagar: sessaoAberta,
  };
}

// ---------------------------------------------------------------------------
// Gestor: cópias, criação e configuração
// ---------------------------------------------------------------------------

export interface CopiaDisponivelDTO {
  dataCopia: string;
  rotulo: string;
  empresas: { codigo: string; nome: string; locais: number; linhas: number; emUso: boolean }[];
}

export async function listarCopiasDisponiveis(): Promise<CopiaDisponivelDTO[]> {
  const [copias, ocupadas] = await Promise.all([listarCopiasEstoque(45), empresasEmUso()]);

  const porData = new Map<string, CopiaDisponivelDTO>();
  for (const c of copias) {
    const atual =
      porData.get(c.dataCopia) ??
      { dataCopia: c.dataCopia, rotulo: rotuloCopia(dataCopiaParaBanco(c.dataCopia)), empresas: [] };
    atual.empresas.push({
      codigo: c.empresaCodigo,
      nome: nomeEmpresa(c.empresaCodigo),
      locais: c.locais,
      linhas: c.linhas,
      emUso: ocupadas.has(c.empresaCodigo),
    });
    porData.set(c.dataCopia, atual);
  }
  return [...porData.values()];
}

// Empresas presas numa contagem em andamento. PREPARANDO conta: duas cópias
// sendo preparadas pra mesma loja dariam dois celulares contando contra
// números diferentes.
async function empresasEmUso(ignorar?: string): Promise<Map<string, string>> {
  const ativas = await prisma.contagemLivre.findMany({
    where: { status: { in: ['PREPARANDO', 'ATIVA'] }, ...(ignorar ? { id: { not: ignorar } } : {}) },
  });
  const mapa = new Map<string, string>();
  for (const c of ativas) {
    if (statusEfetivo(c) === 'ERRO') continue;
    for (const e of c.empresas) mapa.set(e, c.nome);
  }
  return mapa;
}

export interface CriarContagemLivreInput {
  nome?: string;
  dataCopia: string;
  empresas: string[];
  fotoObrigatoria?: boolean;
  travaLocal?: boolean;
  travaDuplicada?: boolean;
  usuarioId: string;
}

export async function criarContagemLivre(input: CriarContagemLivreInput): Promise<ContagemLivreDTO> {
  const dataCopia = dataCopiaParaBanco(input.dataCopia);
  const empresas = [...new Set(input.empresas.map((e) => String(e).trim()).filter(Boolean))];
  if (empresas.length === 0) throw new ErroContagemLivre('Escolha ao menos uma loja.');

  // A cópia tem que existir de verdade pra cada empresa escolhida.
  const copias = await listarCopiasEstoque(60);
  const daData = new Set(copias.filter((c) => c.dataCopia === input.dataCopia).map((c) => c.empresaCodigo));
  const semCopia = empresas.filter((e) => !daData.has(e));
  if (semCopia.length > 0) {
    throw new ErroContagemLivre(
      `Não há cópia de estoque nessa data para ${semCopia.map(nomeEmpresa).join(', ')}.`
    );
  }

  const ocupadas = await empresasEmUso();
  const conflito = empresas.find((e) => ocupadas.has(e));
  if (conflito) {
    throw new ErroContagemLivre(
      `${nomeEmpresa(conflito)} já está na contagem "${ocupadas.get(conflito)}". Encerre aquela antes de começar outra.`,
      'EMPRESA_OCUPADA'
    );
  }

  const nome = input.nome?.trim() || `Contagem ${rotuloCopia(dataCopia).replace('Cópia Estoque Dia ', '')}`;
  const criada = await prisma.contagemLivre.create({
    data: {
      nome,
      dataCopia,
      empresas,
      status: 'PREPARANDO',
      fotoObrigatoria: input.fotoObrigatoria ?? true,
      travaLocal: input.travaLocal ?? true,
      travaDuplicada: input.travaDuplicada ?? true,
      criadaPorId: input.usuarioId,
    },
  });

  // Copiar ~23 mil linhas do Sankhya leva perto de um minuto: segue por
  // baixo, e o painel acompanha pelo status.
  void prepararRetrato(criada.id);
  return montarContagem(criada);
}

// O retrato: cópia + reservas + custos, gravados uma vez.
export async function prepararRetrato(contagemId: string): Promise<void> {
  const contagem = await prisma.contagemLivre.findUnique({ where: { id: contagemId } });
  if (!contagem) return;

  try {
    await prisma.contagemLivreEstoque.deleteMany({ where: { contagemId } });
    const dataCopia = dataCopiaParaSankhya(contagem.dataCopia);

    // Em sequência, não em paralelo: rajada de consultas é o que faz o
    // gateway do Sankhya responder "Não autorizado".
    const linhas = await getRetratoCopia(dataCopia, contagem.empresas);
    if (linhas.length === 0) throw new Error('A cópia escolhida não tem itens para essas lojas.');
    const custos = await getCustosDaCopia(dataCopia, contagem.empresas);
    const reservas = await getReservadosSankhya();

    const LOTE = 2000;
    for (let i = 0; i < linhas.length; i += LOTE) {
      await prisma.contagemLivreEstoque.createMany({
        data: linhas.slice(i, i + LOTE).map((l) => ({
          contagemId,
          empresaCodigo: l.empresaCodigo,
          codigoProduto: l.codigoProduto,
          descricao: l.descricao,
          unidade: l.unidade,
          localCodigo: l.localCodigo,
          local: l.local,
          quantidadeTotal: l.quantidadeTotal,
          quantidadeReservada: reservas.get(chaveReserva(l.codigoProduto, l.localCodigo, l.empresaCodigo)) ?? 0,
          custoSemIcms: custos.get(`${l.codigoProduto}|${l.empresaCodigo}`) ?? null,
        })),
        skipDuplicates: true,
      });
    }

    await prisma.contagemLivre.updateMany({
      where: { id: contagemId, status: { in: ['PREPARANDO', 'ERRO'] } },
      data: { status: 'ATIVA', erro: null },
    });
  } catch (erro) {
    await prisma.contagemLivreEstoque.deleteMany({ where: { contagemId } }).catch(() => undefined);
    await prisma.contagemLivre
      .updateMany({
        where: { id: contagemId, status: 'PREPARANDO' },
        data: { status: 'ERRO', erro: erro instanceof Error ? erro.message : 'Falha ao copiar do Sankhya.' },
      })
      .catch(() => undefined);
  }
}

export async function tentarPrepararDeNovo(contagemId: string): Promise<ContagemLivreDTO> {
  const c = await prisma.contagemLivre.findUnique({ where: { id: contagemId } });
  if (!c) throw new ErroContagemLivre('Contagem não encontrada.', 'NAO_ENCONTRADA');
  if (statusEfetivo(c) !== 'ERRO') throw new ErroContagemLivre('Essa contagem não está com erro.');

  const ocupadas = await empresasEmUso(c.id);
  const conflito = c.empresas.find((e) => ocupadas.has(e));
  if (conflito) {
    throw new ErroContagemLivre(`${nomeEmpresa(conflito)} já está na contagem "${ocupadas.get(conflito)}".`, 'EMPRESA_OCUPADA');
  }

  const reiniciada = await prisma.contagemLivre.update({
    where: { id: c.id },
    data: { status: 'PREPARANDO', erro: null, criadaEm: new Date() },
  });
  void prepararRetrato(c.id);
  return montarContagem(reiniciada);
}

export async function listarContagensLivres(): Promise<(ContagemLivreDTO & { resumo: ResumoContagemLivre })[]> {
  const contagens = await prisma.contagemLivre.findMany({ orderBy: { criadaEm: 'desc' }, take: 50 });
  if (contagens.length === 0) return [];
  const ids = contagens.map((c) => c.id);

  const [itens, locais, registros, finalizados, recontagens] = await Promise.all([
    prisma.contagemLivreEstoque.groupBy({ by: ['contagemId'], where: { contagemId: { in: ids } }, _count: { _all: true } }),
    prisma.contagemLivreEstoque.groupBy({ by: ['contagemId', 'localCodigo'], where: { contagemId: { in: ids } } }),
    prisma.contagemLivreRegistro.groupBy({ by: ['contagemId'], where: { contagemId: { in: ids } }, _count: { _all: true } }),
    prisma.contagemLivreSessao.groupBy({
      by: ['contagemId', 'localCodigo'],
      where: { contagemId: { in: ids }, numeroContagem: 1, finalizadaEm: { not: null } },
    }),
    prisma.contagemLivreRecontagem.groupBy({
      by: ['contagemId'],
      where: { contagemId: { in: ids }, concluidaEm: null },
      _count: { _all: true },
    }),
  ]);

  const conta = <T extends { contagemId: string }>(lista: T[], id: string) => lista.filter((l) => l.contagemId === id).length;
  const total = (lista: { contagemId: string; _count: { _all: number } }[], id: string) =>
    lista.find((l) => l.contagemId === id)?._count._all ?? 0;

  return contagens.map((c) => ({
    ...montarContagem(c),
    resumo: {
      itensNaCopia: total(itens, c.id),
      locaisNaCopia: conta(locais, c.id),
      registros: total(registros, c.id),
      locaisFinalizados: conta(finalizados, c.id),
      recontagensPendentes: total(recontagens, c.id),
    },
  }));
}

// O rótulo que o painel mostra em toda página: a(s) cópia(s) em uso agora.
export async function copiasEmUso(): Promise<{ id: string; nome: string; rotuloCopia: string; empresas: string[] }[]> {
  const ativas = await prisma.contagemLivre.findMany({ where: { status: 'ATIVA' }, orderBy: { criadaEm: 'desc' } });
  return ativas.map((c) => ({
    id: c.id,
    nome: c.nome,
    rotuloCopia: rotuloCopia(c.dataCopia),
    empresas: c.empresas.map(nomeEmpresa),
  }));
}

export async function atualizarContagemLivre(
  contagemId: string,
  dados: { nome?: string; fotoObrigatoria?: boolean; travaLocal?: boolean; travaDuplicada?: boolean }
): Promise<ContagemLivreDTO> {
  const c = await prisma.contagemLivre.findUnique({ where: { id: contagemId } });
  if (!c) throw new ErroContagemLivre('Contagem não encontrada.', 'NAO_ENCONTRADA');
  if (c.status === 'ENCERRADA') throw new ErroContagemLivre('Essa contagem já foi encerrada.');
  const nome = dados.nome?.trim();
  const atualizada = await prisma.contagemLivre.update({
    where: { id: contagemId },
    data: {
      ...(nome ? { nome } : {}),
      ...(dados.fotoObrigatoria !== undefined ? { fotoObrigatoria: dados.fotoObrigatoria } : {}),
      ...(dados.travaLocal !== undefined ? { travaLocal: dados.travaLocal } : {}),
      ...(dados.travaDuplicada !== undefined ? { travaDuplicada: dados.travaDuplicada } : {}),
    },
  });
  return montarContagem(atualizada);
}

export async function encerrarContagemLivre(contagemId: string): Promise<ContagemLivreDTO> {
  const c = await prisma.contagemLivre.findUnique({ where: { id: contagemId } });
  if (!c) throw new ErroContagemLivre('Contagem não encontrada.', 'NAO_ENCONTRADA');
  if (c.status === 'ENCERRADA') return montarContagem(c);
  const agora = new Date();
  // Local aberto em celular de alguém fecha junto: a contagem acabou.
  await prisma.contagemLivreSessao.updateMany({
    where: { contagemId, finalizadaEm: null },
    data: { finalizadaEm: agora },
  });
  const encerrada = await prisma.contagemLivre.update({
    where: { id: contagemId },
    data: { status: 'ENCERRADA', encerradaEm: agora },
  });
  return montarContagem(encerrada);
}

// Só apaga contagem sem nenhum registro: a que nasceu errada (cópia ou loja
// trocada) ou falhou na preparação. Contagem com trabalho dentro se encerra.
export async function excluirContagemLivre(contagemId: string): Promise<void> {
  const c = await prisma.contagemLivre.findUnique({ where: { id: contagemId } });
  if (!c) return;
  const registros = await prisma.contagemLivreRegistro.count({ where: { contagemId } });
  if (registros > 0) {
    throw new ErroContagemLivre('Essa contagem já tem itens contados. Encerre em vez de excluir.');
  }
  await prisma.contagemLivre.delete({ where: { id: contagemId } });
}

// ---------------------------------------------------------------------------
// Colaborador
// ---------------------------------------------------------------------------

async function usuarioAtivo(usuarioId: string) {
  const usuario = await prisma.usuario.findUnique({
    where: { id: usuarioId },
    select: { id: true, nome: true, filial: true, ativo: true, role: true },
  });
  if (!usuario?.ativo) throw new ErroContagemLivre('Usuário não autorizado.', 'NAO_AUTORIZADO');
  return usuario;
}

type Usuario = Awaited<ReturnType<typeof usuarioAtivo>>;

// As contagens que valem pra loja de quem pergunta. Sem loja (gestor, matriz)
// = todas as ativas.
async function contagensVisiveis(usuario: Usuario) {
  const ativas = await prisma.contagemLivre.findMany({ where: { status: 'ATIVA' }, orderBy: { criadaEm: 'desc' } });
  const empresa = empresaDaFilial(usuario.filial);
  return empresa ? ativas.filter((c) => c.empresas.includes(empresa)) : ativas;
}

async function contagemAtivaVisivel(usuario: Usuario, contagemId: string) {
  const contagem = (await contagensVisiveis(usuario)).find((c) => c.id === contagemId);
  if (!contagem) {
    throw new ErroContagemLivre('Essa contagem não está mais ativa. Atualize a tela.', 'CONTAGEM_INATIVA');
  }
  return contagem;
}

export interface SessaoLivreDTO {
  id: string;
  contagemId: string;
  rotuloCopia: string;
  localCodigo: string;
  local: string;
  numeroContagem: number;
  iniciadaEm: string;
  fotoObrigatoria: boolean;
  travaLocal: boolean;
  travaDuplicada: boolean;
  // Quantos produtos a cópia diz ter no local e quantos já foram contados —
  // a barra de progresso. Nunca a quantidade de nenhum deles.
  progresso: { contados: number; total: number };
  meusRegistros: RegistroLivreDTO[];
  // Só na recontagem: QUAIS produtos o gestor pediu pra recontar ali. Quem
  // reconta precisa saber o que procurar; continua sem ver número nenhum.
  recontar: { codigoProduto: string; descricao: string; unidade: string; feito: boolean }[] | null;
}

type LinhaSessao = Awaited<ReturnType<typeof prisma.contagemLivreSessao.findUniqueOrThrow>>;

async function montarSessao(sessao: LinhaSessao, contagem: LinhaContagem, usuario: Usuario): Promise<SessaoLivreDTO> {
  const meus = await prisma.contagemLivreRegistro.findMany({
    where: { sessaoId: sessao.id, usuarioId: usuario.id },
    orderBy: { registradoEm: 'desc' },
  });
  const aberta = sessao.finalizadaEm === null;

  let progresso: SessaoLivreDTO['progresso'];
  let recontar: SessaoLivreDTO['recontar'] = null;

  if (sessao.numeroContagem === 2) {
    const itens = await recontagensDoLocalPara(contagem.id, sessao.localCodigo, usuario, true);
    recontar = itens.map((r) => ({
      codigoProduto: r.codigoProduto,
      descricao: r.descricao,
      unidade: r.unidade,
      feito: r.concluidaEm !== null,
    }));
    progresso = { contados: recontar.filter((r) => r.feito).length, total: recontar.length };
  } else {
    const [naCopia, contados] = await Promise.all([
      prisma.contagemLivreEstoque.findMany({
        where: { contagemId: contagem.id, localCodigo: sessao.localCodigo, quantidadeTotal: { gt: 0 } },
        select: { codigoProduto: true },
      }),
      prisma.contagemLivreRegistro.findMany({
        where: { contagemId: contagem.id, localCodigo: sessao.localCodigo, numeroContagem: 1, foraDoLocal: false },
        select: { codigoProduto: true },
        distinct: ['codigoProduto'],
      }),
    ]);
    const daCopia = new Set(naCopia.map((n) => n.codigoProduto));
    progresso = { contados: contados.filter((c) => daCopia.has(c.codigoProduto)).length, total: daCopia.size };
  }

  return {
    id: sessao.id,
    contagemId: contagem.id,
    rotuloCopia: rotuloCopia(contagem.dataCopia),
    localCodigo: sessao.localCodigo,
    local: sessao.local,
    numeroContagem: sessao.numeroContagem,
    iniciadaEm: sessao.iniciadaEm.toISOString(),
    fotoObrigatoria: contagem.fotoObrigatoria,
    travaLocal: contagem.travaLocal,
    travaDuplicada: contagem.travaDuplicada,
    progresso,
    meusRegistros: meus.map((r) => montarRegistro(r, aberta)),
    recontar,
  };
}

// Recontagens que ESTA pessoa pode fazer num local: pedidas pra ela ou pra
// qualquer um, e nunca de item que ela mesma contou na 1ª.
async function recontagensDoLocalPara(
  contagemId: string,
  localCodigo: string,
  usuario: Usuario,
  incluirConcluidas: boolean
) {
  const pedidas = await prisma.contagemLivreRecontagem.findMany({
    where: {
      contagemId,
      localCodigo,
      ...(incluirConcluidas ? {} : { concluidaEm: null }),
      OR: [{ atribuidaParaId: null }, { atribuidaParaId: usuario.id }],
    },
    orderBy: { descricao: 'asc' },
  });
  if (pedidas.length === 0) return [];
  const contouNaPrimeira = await prisma.contagemLivreRegistro.findMany({
    where: { contagemId, localCodigo, numeroContagem: 1, usuarioId: usuario.id },
    select: { codigoProduto: true, empresaCodigo: true },
  });
  const proprios = new Set(contouNaPrimeira.map((r) => `${r.codigoProduto}|${r.empresaCodigo}`));
  return pedidas.filter((p) => !proprios.has(`${p.codigoProduto}|${p.empresaCodigo}`));
}

export interface EstadoColaboradorDTO {
  contagens: {
    id: string;
    nome: string;
    rotuloCopia: string;
    fotoObrigatoria: boolean;
    travaLocal: boolean;
    travaDuplicada: boolean;
  }[];
  sessao: SessaoLivreDTO | null;
  recontagens: { contagemId: string; localCodigo: string; local: string; itens: number }[];
}

export async function estadoDoColaborador(usuarioId: string): Promise<EstadoColaboradorDTO> {
  const usuario = await usuarioAtivo(usuarioId);
  const contagens = await contagensVisiveis(usuario);
  const ids = contagens.map((c) => c.id);

  const aberta = ids.length
    ? await prisma.contagemLivreSessao.findFirst({
        where: { usuarioId: usuario.id, finalizadaEm: null, contagemId: { in: ids } },
        orderBy: { iniciadaEm: 'desc' },
      })
    : null;

  const pedidas = ids.length
    ? await prisma.contagemLivreRecontagem.findMany({
        where: {
          contagemId: { in: ids },
          concluidaEm: null,
          OR: [{ atribuidaParaId: null }, { atribuidaParaId: usuario.id }],
        },
      })
    : [];
  const minhasPrimeiras = pedidas.length
    ? await prisma.contagemLivreRegistro.findMany({
        where: { contagemId: { in: ids }, numeroContagem: 1, usuarioId: usuario.id },
        select: { contagemId: true, codigoProduto: true, localCodigo: true, empresaCodigo: true },
      })
    : [];
  const proprias = new Set(minhasPrimeiras.map((r) => `${r.contagemId}|${r.codigoProduto}|${r.localCodigo}|${r.empresaCodigo}`));

  const porLocal = new Map<string, EstadoColaboradorDTO['recontagens'][number]>();
  for (const p of pedidas) {
    if (!localVisivelPara(p.localCodigo, usuario.filial)) continue;
    if (proprias.has(`${p.contagemId}|${p.codigoProduto}|${p.localCodigo}|${p.empresaCodigo}`)) continue;
    const chave = `${p.contagemId}|${p.localCodigo}`;
    const atual = porLocal.get(chave) ?? { contagemId: p.contagemId, localCodigo: p.localCodigo, local: p.local, itens: 0 };
    atual.itens += 1;
    porLocal.set(chave, atual);
  }

  const contagemDaSessao = aberta ? contagens.find((c) => c.id === aberta.contagemId)! : null;

  return {
    contagens: contagens.map((c) => ({
      id: c.id,
      nome: c.nome,
      rotuloCopia: rotuloCopia(c.dataCopia),
      fotoObrigatoria: c.fotoObrigatoria,
      travaLocal: c.travaLocal,
      travaDuplicada: c.travaDuplicada,
    })),
    sessao: aberta && contagemDaSessao ? await montarSessao(aberta, contagemDaSessao, usuario) : null,
    recontagens: [...porLocal.values()].sort((a, b) => a.local.localeCompare(b.local, 'pt-BR', { numeric: true })),
  };
}

export async function getSessao(usuarioId: string, sessaoId: string): Promise<SessaoLivreDTO> {
  const usuario = await usuarioAtivo(usuarioId);
  const sessao = await prisma.contagemLivreSessao.findUnique({ where: { id: sessaoId } });
  if (!sessao || sessao.usuarioId !== usuario.id) throw new ErroContagemLivre('Local não encontrado.', 'NAO_ENCONTRADA');
  const contagem = await prisma.contagemLivre.findUniqueOrThrow({ where: { id: sessao.contagemId } });
  return montarSessao(sessao, contagem, usuario);
}

export async function abrirLocal(input: {
  usuarioId: string;
  contagemId: string;
  codigoLocal: string;
  numeroContagem?: number;
  finalizarAberta?: boolean;
}): Promise<SessaoLivreDTO> {
  const usuario = await usuarioAtivo(input.usuarioId);
  const contagem = await contagemAtivaVisivel(usuario, input.contagemId);
  const codigo = input.codigoLocal.trim();
  const numero = input.numeroContagem === 2 ? 2 : 1;

  if (!/^\d{1,12}$/.test(codigo)) {
    throw new ErroContagemLivre('Isso não é uma etiqueta de local. Bipe a etiqueta da prateleira.', 'NAO_E_LOCAL');
  }
  if (!localVisivelPara(codigo, usuario.filial)) {
    throw new ErroContagemLivre(`Esse local não é da loja ${labelFilial(usuario.filial)}.`, 'OUTRA_LOJA');
  }

  const naCopia = await prisma.contagemLivreEstoque.findMany({
    where: { contagemId: contagem.id, localCodigo: codigo },
    select: { empresaCodigo: true, local: true },
  });

  let nomeLocal: string;
  let empresa: string | null;
  if (naCopia.length > 0) {
    nomeLocal = naCopia[0].local;
    const contagemPorEmpresa = new Map<string, number>();
    for (const n of naCopia) contagemPorEmpresa.set(n.empresaCodigo, (contagemPorEmpresa.get(n.empresaCodigo) ?? 0) + 1);
    empresa = [...contagemPorEmpresa.entries()].sort((a, b) => b[1] - a[1])[0][0];
  } else {
    // Prateleira sem saldo nenhum na cópia: pode ser local vazio no ERP, ou
    // nem ser etiqueta de local. Só o cadastro de locais distingue.
    let doSankhya;
    try {
      doSankhya = await getLocalSankhya(codigo);
    } catch {
      throw new ErroContagemLivre('Não consegui confirmar esse local no Sankhya agora. Tente de novo.', 'SANKHYA');
    }
    if (!doSankhya) {
      throw new ErroContagemLivre('Etiqueta não reconhecida. Bipe a etiqueta da prateleira.', 'NAO_E_LOCAL');
    }
    nomeLocal = doSankhya.local;
    empresa = empresaDaFilial(filialDoLocal(codigo));
  }

  if (ehLocalDeQuarentena(nomeLocal)) {
    throw new ErroContagemLivre(`${nomeLocal} é área de quarentena — não entra na contagem.`, 'QUARENTENA');
  }
  if (empresa && !contagem.empresas.includes(empresa)) {
    throw new ErroContagemLivre(`${nomeLocal} é de ${nomeEmpresa(empresa)}, que não está nesta contagem.`, 'OUTRA_LOJA');
  }
  if (numero === 2 && (await recontagensDoLocalPara(contagem.id, codigo, usuario, false)).length === 0) {
    throw new ErroContagemLivre('Não há recontagem pedida pra você neste local.', 'SEM_RECONTAGEM');
  }

  // Um local aberto por vez. É o "Finalizar" que fecha o local, e é por ele
  // que o relatório sabe quais locais foram varridos de verdade.
  const aberta = await prisma.contagemLivreSessao.findFirst({ where: { usuarioId: usuario.id, finalizadaEm: null } });
  if (aberta) {
    if (aberta.contagemId === contagem.id && aberta.localCodigo === codigo && aberta.numeroContagem === numero) {
      return montarSessao(aberta, contagem, usuario);
    }
    if (!input.finalizarAberta) {
      throw new ErroContagemLivre(`Você ainda está em ${aberta.local}. Finalize esse local antes de abrir outro.`, 'SESSAO_ABERTA', {
        sessaoId: aberta.id,
        local: aberta.local,
      });
    }
    await prisma.contagemLivreSessao.update({ where: { id: aberta.id }, data: { finalizadaEm: new Date() } });
  }

  const sessao = await prisma.contagemLivreSessao.create({
    data: {
      contagemId: contagem.id,
      localCodigo: codigo,
      local: nomeLocal,
      empresaCodigo: empresa,
      numeroContagem: numero,
      usuarioId: usuario.id,
    },
  });
  return montarSessao(sessao, contagem, usuario);
}

async function sessaoAbertaDe(usuario: Usuario, sessaoId: string) {
  const sessao = await prisma.contagemLivreSessao.findUnique({ where: { id: sessaoId } });
  if (!sessao || sessao.usuarioId !== usuario.id) throw new ErroContagemLivre('Local não encontrado.', 'NAO_ENCONTRADA');
  if (sessao.finalizadaEm) {
    throw new ErroContagemLivre('Esse local já foi finalizado. Bipe a etiqueta de novo pra reabrir.', 'SESSAO_FINALIZADA');
  }
  const contagem = await contagemAtivaVisivel(usuario, sessao.contagemId);
  return { sessao, contagem };
}

export interface ProdutoConferidoDTO {
  codigoProduto: string;
  descricao: string;
  unidade: string;
  empresaCodigo: string;
  // O código lido é de caixa/pacote: quem conta precisa saber que 1 bipe não
  // é 1 peça (ver getProdutoPorCodigoBarras).
  unidadeDoCodigo: { unidade: string; equivale: number } | null;
}

export type ConferenciaProdutoDTO =
  | { status: 'OK'; produto: ProdutoConferidoDTO; foraDoLocal: boolean }
  | { status: 'VARIOS'; produtos: ProdutoConferidoDTO[]; mensagem: string }
  | { status: 'FORA_DO_LOCAL'; produto: ProdutoConferidoDTO; mensagem: string }
  | { status: 'JA_CONTADO'; produto: ProdutoConferidoDTO; mensagem: string }
  | { status: 'NAO_PEDIDO'; produto: ProdutoConferidoDTO; mensagem: string }
  | { status: 'ETIQUETA_DE_LOCAL'; mensagem: string }
  | { status: 'NAO_IDENTIFICADO'; mensagem: string };

interface Candidato {
  codigoProduto: string;
  descricao: string;
  unidade: string;
  unidadeDoCodigo: { unidade: string; equivale: number } | null;
}

// Quais produtos o código lido pode ser. A ordem é da certeza pro palpite:
// SKU que está na cópia, código de barras do ERP (TGFVOA/TGFBAR) e CODPROD,
// e por fim o que bipes anteriores já ensinaram.
async function candidatosDoCodigo(contagemId: string, lido: string): Promise<{ etiquetaDeLocal: boolean; candidatos: Candidato[] }> {
  const porCodigo = new Map<string, Candidato>();

  const sku = await prisma.contagemLivreEstoque.findFirst({
    where: { contagemId, codigoProduto: lido },
    select: { codigoProduto: true, descricao: true, unidade: true },
  });
  if (sku) porCodigo.set(sku.codigoProduto, { ...sku, unidadeDoCodigo: null });

  const [resposta, aprendidos, ehLocalDaCopia] = await Promise.all([
    resolverProdutoDoBipe(lido),
    prisma.contagemLivreRegistro.findMany({
      where: { codigoBipado: lido },
      select: { codigoProduto: true, descricao: true, unidade: true },
      distinct: ['codigoProduto'],
      take: 10,
    }),
    prisma.contagemLivreEstoque.findFirst({ where: { contagemId, localCodigo: lido }, select: { id: true } }),
  ]);

  for (const p of resposta.produtos) {
    if (porCodigo.has(p.codigoProduto)) continue;
    porCodigo.set(p.codigoProduto, {
      codigoProduto: p.codigoProduto,
      descricao: p.descricao,
      unidade: p.unidade,
      unidadeDoCodigo: p.unidadeDoCodigo ?? null,
    });
  }
  for (const a of aprendidos) {
    if (!porCodigo.has(a.codigoProduto)) porCodigo.set(a.codigoProduto, { ...a, unidadeDoCodigo: null });
  }

  return {
    // Só vale como etiqueta de local quando o código não resolveu em produto
    // nenhum: um SKU pode coincidir com o número de um local.
    etiquetaDeLocal: porCodigo.size === 0 && (resposta.ehEtiquetaDeLocal || ehLocalDaCopia !== null),
    candidatos: [...porCodigo.values()],
  };
}

async function produtoPorCodigo(contagemId: string, codigoProduto: string): Promise<Candidato | null> {
  const daCopia = await prisma.contagemLivreEstoque.findFirst({
    where: { contagemId, codigoProduto },
    select: { codigoProduto: true, descricao: true, unidade: true },
  });
  if (daCopia) return { ...daCopia, unidadeDoCodigo: null };
  const doSankhya = (await buscarProdutosSankhya(codigoProduto)).find((p) => p.codigoProduto === codigoProduto);
  return doSankhya
    ? { codigoProduto: doSankhya.codigoProduto, descricao: doSankhya.descricao, unidade: doSankhya.unidade, unidadeDoCodigo: null }
    : null;
}

const quando = (d: Date) =>
  d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Sao_Paulo' });

// A conferência do bipe, ANTES de digitar a quantidade: a pessoa descobre na
// hora que o produto não é do local ou já foi contado, e não depois de contar
// as peças. O registro repete a mesma conferência (o app não é fonte de
// verdade) — é uma regra só, nos dois lugares.
export async function conferirProduto(input: {
  usuarioId: string;
  sessaoId: string;
  codigo?: string;
  codigoProduto?: string;
  confirmarForaDoLocal?: boolean;
}): Promise<ConferenciaProdutoDTO> {
  const usuario = await usuarioAtivo(input.usuarioId);
  const { sessao, contagem } = await sessaoAbertaDe(usuario, input.sessaoId);
  return conferir(usuario, sessao, contagem, input);
}

async function conferir(
  usuario: Usuario,
  sessao: LinhaSessao,
  contagem: LinhaContagem,
  input: { codigo?: string; codigoProduto?: string; confirmarForaDoLocal?: boolean }
): Promise<ConferenciaProdutoDTO> {
  let candidatos: Candidato[];
  if (input.codigoProduto?.trim()) {
    const p = await produtoPorCodigo(contagem.id, input.codigoProduto.trim());
    if (!p) return { status: 'NAO_IDENTIFICADO', mensagem: 'Produto não encontrado no Sankhya.' };
    // A unidade do código lido acompanha o produto escolhido da lista, quando
    // a escolha veio de um bipe ambíguo.
    if (input.codigo?.trim()) {
      const doBipe = (await candidatosDoCodigo(contagem.id, input.codigo.trim())).candidatos.find(
        (c) => c.codigoProduto === p.codigoProduto
      );
      if (doBipe?.unidadeDoCodigo) p.unidadeDoCodigo = doBipe.unidadeDoCodigo;
    }
    candidatos = [p];
  } else {
    const lido = input.codigo?.trim() ?? '';
    if (!lido) return { status: 'NAO_IDENTIFICADO', mensagem: 'Nenhum código lido.' };
    const r = await candidatosDoCodigo(contagem.id, lido);
    if (r.etiquetaDeLocal) {
      return { status: 'ETIQUETA_DE_LOCAL', mensagem: 'Essa é a etiqueta de um local. Bipe o código do produto.' };
    }
    if (r.candidatos.length === 0) {
      return { status: 'NAO_IDENTIFICADO', mensagem: 'Código não identificado. Procure o produto pelo nome ou SKU.' };
    }
    candidatos = r.candidatos;
  }

  const noLocal = await prisma.contagemLivreEstoque.findMany({
    where: {
      contagemId: contagem.id,
      localCodigo: sessao.localCodigo,
      codigoProduto: { in: candidatos.map((c) => c.codigoProduto) },
    },
    select: { codigoProduto: true, empresaCodigo: true },
  });
  const empresaNoLocal = new Map(noLocal.map((n) => [n.codigoProduto, n.empresaCodigo]));

  const comEmpresa = async (c: Candidato): Promise<ProdutoConferidoDTO> => {
    let empresa = empresaNoLocal.get(c.codigoProduto) ?? sessao.empresaCodigo;
    if (!empresa) {
      const qualquer = await prisma.contagemLivreEstoque.findFirst({
        where: { contagemId: contagem.id, codigoProduto: c.codigoProduto },
        select: { empresaCodigo: true },
      });
      empresa = qualquer?.empresaCodigo ?? contagem.empresas[0];
    }
    return { ...c, empresaCodigo: empresa };
  };

  // --- Recontagem: só o que o gestor pediu ali.
  if (sessao.numeroContagem === 2) {
    const pedidas = await recontagensDoLocalPara(contagem.id, sessao.localCodigo, usuario, true);
    const daLista = candidatos.filter((c) => pedidas.some((p) => p.codigoProduto === c.codigoProduto));
    if (daLista.length === 0) {
      return {
        status: 'NAO_PEDIDO',
        produto: await comEmpresa(candidatos[0]),
        mensagem: 'Esse produto não está na recontagem deste local.',
      };
    }
    if (daLista.length > 1) {
      return { status: 'VARIOS', produtos: await Promise.all(daLista.map(comEmpresa)), mensagem: 'Esse código serve pra mais de um produto. Escolha o que está contando.' };
    }
    const alvo = daLista[0];
    const pedido = pedidas.find((p) => p.codigoProduto === alvo.codigoProduto)!;
    const produto = { ...alvo, empresaCodigo: pedido.empresaCodigo };
    if (pedido.concluidaEm) {
      return { status: 'JA_CONTADO', produto, mensagem: 'Esse produto já foi recontado.' };
    }
    return { status: 'OK', produto, foraDoLocal: !empresaNoLocal.has(alvo.codigoProduto) };
  }

  // --- 1ª contagem.
  const noLocalCandidatos = candidatos.filter((c) => empresaNoLocal.has(c.codigoProduto));
  const escolhidos = noLocalCandidatos.length > 0 ? noLocalCandidatos : candidatos;
  if (escolhidos.length > 1) {
    return {
      status: 'VARIOS',
      produtos: await Promise.all(escolhidos.map(comEmpresa)),
      mensagem: 'Esse código serve pra mais de um produto. Escolha o que está contando.',
    };
  }

  const produto = await comEmpresa(escolhidos[0]);
  const foraDoLocal = !empresaNoLocal.has(produto.codigoProduto);

  if (foraDoLocal && contagem.travaLocal && !input.confirmarForaDoLocal) {
    return {
      status: 'FORA_DO_LOCAL',
      produto,
      mensagem: `${produto.descricao} não consta em ${sessao.local} na cópia de estoque.`,
    };
  }

  if (contagem.travaDuplicada) {
    const ja = await prisma.contagemLivreRegistro.findFirst({
      where: {
        contagemId: contagem.id,
        codigoProduto: produto.codigoProduto,
        localCodigo: sessao.localCodigo,
        empresaCodigo: produto.empresaCodigo,
        numeroContagem: 1,
      },
      include: { usuario: { select: { nome: true } } },
    });
    if (ja) {
      return {
        status: 'JA_CONTADO',
        produto,
        mensagem:
          ja.usuarioId === usuario.id
            ? `Você já contou esse produto aqui às ${quando(ja.registradoEm)}. Pra corrigir, apague o registro em "O que já contei".`
            : `Esse produto já foi contado neste local por ${ja.usuario.nome} às ${quando(ja.registradoEm)}.`,
      };
    }
  }

  return { status: 'OK', produto, foraDoLocal };
}

export async function registrar(input: {
  usuarioId: string;
  sessaoId: string;
  codigoProduto: string;
  quantidade: number;
  codigoBipado?: string;
  iniciadoEm?: string;
  confirmarForaDoLocal?: boolean;
  foto?: { buffer: Buffer; mimeType: string };
}): Promise<RegistroLivreDTO> {
  const usuario = await usuarioAtivo(input.usuarioId);
  const { sessao, contagem } = await sessaoAbertaDe(usuario, input.sessaoId);

  if (!Number.isFinite(input.quantidade) || input.quantidade < 0 || input.quantidade > 10_000_000) {
    throw new ErroContagemLivre('Informe a quantidade contada.', 'QUANTIDADE');
  }
  const quantidade = Math.round(input.quantidade * 1000) / 1000;

  if (contagem.fotoObrigatoria && !input.foto) {
    throw new ErroContagemLivre('Tire a foto antes de registrar.', 'FOTO_OBRIGATORIA');
  }
  validarFotoContagem(input.foto);

  const conferido = await conferir(usuario, sessao, contagem, {
    codigoProduto: input.codigoProduto,
    codigo: input.codigoBipado,
    confirmarForaDoLocal: input.confirmarForaDoLocal,
  });
  if (conferido.status !== 'OK') {
    throw new ErroContagemLivre(
      'mensagem' in conferido ? conferido.mensagem : 'Não foi possível conferir o produto.',
      conferido.status
    );
  }
  const { produto, foraDoLocal } = conferido;

  // Hora em que a pessoa bipou o produto, vinda do celular. Só vale se for
  // plausível: no futuro ou de mais de um dia atrás vira "agora".
  const agora = new Date();
  const informado = input.iniciadoEm ? new Date(input.iniciadoEm) : null;
  const iniciadoEm =
    informado && !Number.isNaN(informado.getTime()) && informado <= agora && agora.getTime() - informado.getTime() < 86_400_000
      ? informado
      : agora;

  const numero = sessao.numeroContagem;
  const fotoChave = input.foto
    ? await uploadFotoContagem(
        `livre-${contagem.id}-${produto.codigoProduto}-${sessao.localCodigo}`,
        numero,
        input.foto.buffer,
        input.foto.mimeType
      )
    : null;

  // Recontagem é sempre única por item; a 1ª, só com a trava ligada.
  const chaveUnica =
    numero === 2 || contagem.travaDuplicada
      ? `${contagem.id}|${produto.codigoProduto}|${sessao.localCodigo}|${produto.empresaCodigo}|${numero}`
      : null;

  let criado;
  try {
    criado = await prisma.contagemLivreRegistro.create({
      data: {
        contagemId: contagem.id,
        sessaoId: sessao.id,
        numeroContagem: numero,
        empresaCodigo: produto.empresaCodigo,
        codigoProduto: produto.codigoProduto,
        descricao: produto.descricao,
        unidade: produto.unidade,
        localCodigo: sessao.localCodigo,
        local: sessao.local,
        quantidade,
        foraDoLocal,
        codigoBipado: input.codigoBipado?.trim() || null,
        usuarioId: usuario.id,
        iniciadoEm,
        fotoChave,
        chaveUnica,
      },
    });
  } catch (erro) {
    if (fotoChave) await removerFotoContagem(fotoChave).catch(() => undefined);
    if ((erro as { code?: string }).code === 'P2002') {
      throw new ErroContagemLivre('Esse produto acabou de ser contado neste local por outra pessoa.', 'JA_CONTADO');
    }
    throw erro;
  }

  if (numero === 2) {
    await prisma.contagemLivreRecontagem.updateMany({
      where: {
        contagemId: contagem.id,
        codigoProduto: produto.codigoProduto,
        localCodigo: sessao.localCodigo,
        empresaCodigo: produto.empresaCodigo,
      },
      data: { concluidaEm: agora },
    });
  }

  return montarRegistro(criado, true);
}

export async function apagarRegistro(usuarioId: string, registroId: string): Promise<void> {
  const usuario = await usuarioAtivo(usuarioId);
  const registro = await prisma.contagemLivreRegistro.findUnique({ where: { id: registroId } });
  if (!registro || registro.usuarioId !== usuario.id) throw new ErroContagemLivre('Registro não encontrado.', 'NAO_ENCONTRADA');
  await sessaoAbertaDe(usuario, registro.sessaoId);

  await prisma.contagemLivreRegistro.delete({ where: { id: registro.id } });
  if (registro.fotoChave) await removerFotoContagem(registro.fotoChave).catch(() => undefined);
  if (registro.numeroContagem === 2) {
    await prisma.contagemLivreRecontagem.updateMany({
      where: {
        contagemId: registro.contagemId,
        codigoProduto: registro.codigoProduto,
        localCodigo: registro.localCodigo,
        empresaCodigo: registro.empresaCodigo,
      },
      data: { concluidaEm: null },
    });
  }
}

export async function finalizarLocal(usuarioId: string, sessaoId: string): Promise<{ local: string; registros: number }> {
  const usuario = await usuarioAtivo(usuarioId);
  const sessao = await prisma.contagemLivreSessao.findUnique({ where: { id: sessaoId } });
  if (!sessao || sessao.usuarioId !== usuario.id) throw new ErroContagemLivre('Local não encontrado.', 'NAO_ENCONTRADA');
  if (!sessao.finalizadaEm) {
    await prisma.contagemLivreSessao.update({ where: { id: sessao.id }, data: { finalizadaEm: new Date() } });
  }
  const registros = await prisma.contagemLivreRegistro.count({ where: { sessaoId: sessao.id } });
  return { local: sessao.local, registros };
}

// "O que já contei": tudo desta pessoa na contagem, do mais recente pro mais
// antigo — com a quantidade que ELA digitou. O esperado nunca aparece.
export async function meusRegistros(usuarioId: string, contagemId: string): Promise<RegistroLivreDTO[]> {
  const usuario = await usuarioAtivo(usuarioId);
  const registros = await prisma.contagemLivreRegistro.findMany({
    where: { contagemId, usuarioId: usuario.id },
    include: { sessao: { select: { finalizadaEm: true } } },
    orderBy: { registradoEm: 'desc' },
    take: 500,
  });
  return registros.map((r) => montarRegistro(r, r.sessao.finalizadaEm === null));
}

// ---------------------------------------------------------------------------
// Gestor: recontagem
// ---------------------------------------------------------------------------

export async function pedirRecontagem(input: {
  contagemId: string;
  itens: { codigoProduto: string; localCodigo: string; empresaCodigo: string }[];
  atribuidaParaId?: string | null;
  solicitadaPorId: string;
}): Promise<{ pedidas: number; ignoradas: string[] }> {
  const contagem = await prisma.contagemLivre.findUnique({ where: { id: input.contagemId } });
  if (!contagem || contagem.status !== 'ATIVA') {
    throw new ErroContagemLivre('Recontagem só pode ser pedida numa contagem ativa.');
  }
  if (input.itens.length === 0) throw new ErroContagemLivre('Escolha ao menos um item.');

  const ignoradas: string[] = [];
  let pedidas = 0;
  for (const item of input.itens) {
    const [daCopia, primeiro, jaPedida] = await Promise.all([
      prisma.contagemLivreEstoque.findFirst({
        where: { contagemId: contagem.id, codigoProduto: item.codigoProduto, localCodigo: item.localCodigo, empresaCodigo: item.empresaCodigo },
      }),
      prisma.contagemLivreRegistro.findFirst({
        where: { contagemId: contagem.id, codigoProduto: item.codigoProduto, localCodigo: item.localCodigo, empresaCodigo: item.empresaCodigo, numeroContagem: 1 },
      }),
      prisma.contagemLivreRecontagem.findUnique({
        where: {
          contagemId_codigoProduto_localCodigo_empresaCodigo: {
            contagemId: contagem.id,
            codigoProduto: item.codigoProduto,
            localCodigo: item.localCodigo,
            empresaCodigo: item.empresaCodigo,
          },
        },
      }),
    ]);
    const base = daCopia ?? primeiro;
    const rotulo = base ? `${base.descricao} (${base.local})` : `${item.codigoProduto} em ${item.localCodigo}`;
    if (!base) {
      ignoradas.push(`${rotulo}: não está na cópia nem foi contado.`);
      continue;
    }
    if (jaPedida?.concluidaEm) {
      ignoradas.push(`${rotulo}: já foi recontado.`);
      continue;
    }
    if (input.atribuidaParaId && primeiro?.usuarioId === input.atribuidaParaId) {
      ignoradas.push(`${rotulo}: quem reconta não pode ser quem contou.`);
      continue;
    }

    await prisma.contagemLivreRecontagem.upsert({
      where: {
        contagemId_codigoProduto_localCodigo_empresaCodigo: {
          contagemId: contagem.id,
          codigoProduto: item.codigoProduto,
          localCodigo: item.localCodigo,
          empresaCodigo: item.empresaCodigo,
        },
      },
      update: { atribuidaParaId: input.atribuidaParaId ?? null, solicitadaPorId: input.solicitadaPorId, solicitadaEm: new Date() },
      create: {
        contagemId: contagem.id,
        empresaCodigo: item.empresaCodigo,
        codigoProduto: item.codigoProduto,
        descricao: base.descricao,
        unidade: base.unidade,
        localCodigo: item.localCodigo,
        local: base.local,
        solicitadaPorId: input.solicitadaPorId,
        atribuidaParaId: input.atribuidaParaId ?? null,
      },
    });
    pedidas += 1;
  }
  return { pedidas, ignoradas };
}

export async function cancelarRecontagem(input: {
  contagemId: string;
  codigoProduto: string;
  localCodigo: string;
  empresaCodigo: string;
}): Promise<void> {
  await prisma.contagemLivreRecontagem.deleteMany({
    where: { ...input, concluidaEm: null },
  });
}

// ---------------------------------------------------------------------------
// Relatório
// ---------------------------------------------------------------------------

export interface LinhaRelatorioLivre {
  chave: string;
  empresaCodigo: string;
  empresa: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  localCodigo: string;
  local: string;
  // NAO_CONTADO = estava na cópia de um local já finalizado e ninguém contou.
  // Sai sem número de propósito: quem decide o que ele significa é o gestor.
  situacao: 'CONTADO' | 'NAO_CONTADO';
  foraDoLocal: boolean;
  // Onde a cópia diz que o produto está, quando ele foi achado fora.
  locaisNaCopia: string[];
  // A que vale: a 2ª quando existe, senão a 1ª.
  quantidadeContada: number | null;
  quantidade1: number | null;
  quantidade2: number | null;
  quantidadeTotal: number;
  quantidadeReservada: number;
  quantidadeDisponivel: number;
  // Contada − disponível.
  quantidadeDivergente: number | null;
  usuario1: string | null;
  inicio1: string | null;
  fim1: string | null;
  usuario2: string | null;
  inicio2: string | null;
  fim2: string | null;
  custoUnitario: number | null;
  custoContagem: number | null;
  custoSistema: number | null;
  recontagem: 'NAO' | 'PENDENTE' | 'FEITA';
  fotos: { registroId: string; numeroContagem: number }[];
}

export async function relatorioContagemLivre(
  contagemId: string
): Promise<{ contagem: ContagemLivreDTO; linhas: LinhaRelatorioLivre[] }> {
  const contagem = await prisma.contagemLivre.findUnique({ where: { id: contagemId } });
  if (!contagem) throw new ErroContagemLivre('Contagem não encontrada.', 'NAO_ENCONTRADA');

  const [estoque, registros, finalizadas, recontagens] = await Promise.all([
    prisma.contagemLivreEstoque.findMany({
      where: { contagemId },
      select: {
        empresaCodigo: true, codigoProduto: true, descricao: true, unidade: true,
        localCodigo: true, local: true, quantidadeTotal: true, quantidadeReservada: true, custoSemIcms: true,
      },
    }),
    prisma.contagemLivreRegistro.findMany({
      where: { contagemId },
      include: { usuario: { select: { nome: true } } },
      orderBy: { registradoEm: 'asc' },
    }),
    prisma.contagemLivreSessao.findMany({
      where: { contagemId, numeroContagem: 1, finalizadaEm: { not: null } },
      select: { localCodigo: true },
      distinct: ['localCodigo'],
    }),
    prisma.contagemLivreRecontagem.findMany({ where: { contagemId } }),
  ]);

  const chaveDe = (p: string, l: string, e: string) => `${p}|${l}|${e}`;
  const porChave = new Map(estoque.map((e) => [chaveDe(e.codigoProduto, e.localCodigo, e.empresaCodigo), e]));
  const custoPorProduto = new Map<string, number>();
  const locaisDoProduto = new Map<string, Set<string>>();
  for (const e of estoque) {
    if (e.custoSemIcms !== null) custoPorProduto.set(`${e.codigoProduto}|${e.empresaCodigo}`, e.custoSemIcms);
    const locais = locaisDoProduto.get(e.codigoProduto) ?? new Set<string>();
    if (e.quantidadeTotal > 0) locais.add(e.local);
    locaisDoProduto.set(e.codigoProduto, locais);
  }

  const porItem = new Map<string, { n1: typeof registros; n2: typeof registros }>();
  for (const r of registros) {
    const k = chaveDe(r.codigoProduto, r.localCodigo, r.empresaCodigo);
    const atual = porItem.get(k) ?? { n1: [], n2: [] };
    (r.numeroContagem === 2 ? atual.n2 : atual.n1).push(r);
    porItem.set(k, atual);
  }
  const recontagemDe = new Map(recontagens.map((r) => [chaveDe(r.codigoProduto, r.localCodigo, r.empresaCodigo), r]));
  const locaisFinalizados = new Set(finalizadas.map((f) => f.localCodigo));

  const chaves = new Set<string>(porItem.keys());
  for (const e of estoque) {
    if (e.quantidadeTotal > 0 && locaisFinalizados.has(e.localCodigo)) {
      chaves.add(chaveDe(e.codigoProduto, e.localCodigo, e.empresaCodigo));
    }
  }
  for (const k of recontagemDe.keys()) chaves.add(k);

  const nomes = (lista: typeof registros) => [...new Set(lista.map((r) => r.usuario.nome))].join(', ') || null;
  const soma = (lista: typeof registros) =>
    lista.length ? Math.round(lista.reduce((t, r) => t + r.quantidade, 0) * 1000) / 1000 : null;
  const primeiro = (lista: typeof registros) =>
    lista.length ? new Date(Math.min(...lista.map((r) => r.iniciadoEm.getTime()))).toISOString() : null;
  const ultimo = (lista: typeof registros) =>
    lista.length ? new Date(Math.max(...lista.map((r) => r.registradoEm.getTime()))).toISOString() : null;
  const dinheiro = (v: number) => Math.round(v * 100) / 100;

  const linhas: LinhaRelatorioLivre[] = [];
  for (const k of chaves) {
    const [codigoProduto, localCodigo, empresaCodigo] = k.split('|');
    const naCopia = porChave.get(k);
    const item = porItem.get(k) ?? { n1: [], n2: [] };
    const qualquer = item.n1[0] ?? item.n2[0];
    const rec = recontagemDe.get(k);

    const quantidade1 = soma(item.n1);
    const quantidade2 = soma(item.n2);
    const quantidadeContada = quantidade2 ?? quantidade1;
    const quantidadeTotal = naCopia?.quantidadeTotal ?? 0;
    const quantidadeReservada = naCopia?.quantidadeReservada ?? 0;
    const quantidadeDisponivel = Math.round((quantidadeTotal - quantidadeReservada) * 1000) / 1000;
    const custoUnitario = naCopia?.custoSemIcms ?? custoPorProduto.get(`${codigoProduto}|${empresaCodigo}`) ?? null;
    const foraDoLocal = [...item.n1, ...item.n2].some((r) => r.foraDoLocal);

    linhas.push({
      chave: k,
      empresaCodigo,
      empresa: nomeEmpresa(empresaCodigo),
      codigoProduto,
      descricao: naCopia?.descricao ?? qualquer?.descricao ?? rec?.descricao ?? codigoProduto,
      unidade: naCopia?.unidade ?? qualquer?.unidade ?? rec?.unidade ?? '',
      localCodigo,
      local: naCopia?.local ?? qualquer?.local ?? rec?.local ?? localCodigo,
      situacao: quantidadeContada === null ? 'NAO_CONTADO' : 'CONTADO',
      foraDoLocal,
      locaisNaCopia: foraDoLocal ? [...(locaisDoProduto.get(codigoProduto) ?? [])].sort() : [],
      quantidadeContada,
      quantidade1,
      quantidade2,
      quantidadeTotal,
      quantidadeReservada,
      quantidadeDisponivel,
      quantidadeDivergente:
        quantidadeContada === null ? null : Math.round((quantidadeContada - quantidadeDisponivel) * 1000) / 1000,
      usuario1: nomes(item.n1),
      inicio1: primeiro(item.n1),
      fim1: ultimo(item.n1),
      usuario2: nomes(item.n2),
      inicio2: primeiro(item.n2),
      fim2: ultimo(item.n2),
      custoUnitario,
      custoContagem: custoUnitario === null || quantidadeContada === null ? null : dinheiro(quantidadeContada * custoUnitario),
      custoSistema: custoUnitario === null ? null : dinheiro(quantidadeTotal * custoUnitario),
      recontagem: !rec ? 'NAO' : rec.concluidaEm ? 'FEITA' : 'PENDENTE',
      fotos: [...item.n1, ...item.n2]
        .filter((r) => r.fotoChave)
        .map((r) => ({ registroId: r.id, numeroContagem: r.numeroContagem })),
    });
  }

  linhas.sort(
    (a, b) =>
      a.local.localeCompare(b.local, 'pt-BR', { numeric: true }) ||
      a.descricao.localeCompare(b.descricao, 'pt-BR')
  );
  return { contagem: montarContagem(contagem), linhas };
}

const formatoHora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '';

export async function gerarRelatorioXlsx(contagemId: string): Promise<{ buffer: ExcelJS.Buffer; nomeArquivo: string }> {
  const { contagem, linhas } = await relatorioContagemLivre(contagemId);

  const workbook = new ExcelJS.Workbook();
  const planilha = workbook.addWorksheet('Contagem');

  planilha.addRow([contagem.nome]).font = { bold: true, size: 14 };
  planilha.addRow([contagem.rotuloCopia]);
  planilha.addRow([`Lojas: ${contagem.empresas.map((e) => e.nome).join(', ')}`]);
  planilha.addRow([`Gerado em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`]);
  planilha.addRow([]);

  // As 18 primeiras colunas são exatamente as que a operação pediu, nessa
  // ordem. Depois delas vem o que o relatório precisa pra ser lido sem
  // ambiguidade: a situação, o fora-do-local e a quantidade de cada contagem.
  const colunas: { titulo: string; largura: number; valor: (l: LinhaRelatorioLivre) => string | number | null; numero?: string }[] = [
    { titulo: 'CODPROD', largura: 11, valor: (l) => Number(l.codigoProduto) || l.codigoProduto },
    { titulo: 'DESCPROD', largura: 44, valor: (l) => l.descricao },
    { titulo: 'Quantidade Contada', largura: 12, valor: (l) => l.quantidadeContada, numero: '#,##0.###' },
    { titulo: 'Quantidade Disponível', largura: 12, valor: (l) => l.quantidadeDisponivel, numero: '#,##0.###' },
    { titulo: 'Quantidade Total', largura: 12, valor: (l) => l.quantidadeTotal, numero: '#,##0.###' },
    { titulo: 'Quantidade Reservada', largura: 12, valor: (l) => l.quantidadeReservada, numero: '#,##0.###' },
    { titulo: 'Quantidade Divergente', largura: 12, valor: (l) => l.quantidadeDivergente, numero: '#,##0.###;[Red]-#,##0.###' },
    { titulo: 'CODLOCAL', largura: 11, valor: (l) => Number(l.localCodigo) || l.localCodigo },
    { titulo: 'DESCLOCAL', largura: 32, valor: (l) => l.local },
    { titulo: 'Usuário que contou', largura: 18, valor: (l) => l.usuario1 },
    { titulo: 'Início 1ª contagem', largura: 19, valor: (l) => formatoHora(l.inicio1) },
    { titulo: 'Fim 1ª contagem', largura: 19, valor: (l) => formatoHora(l.fim1) },
    { titulo: '2º usuário que contou', largura: 18, valor: (l) => l.usuario2 },
    { titulo: 'Início 2ª contagem', largura: 19, valor: (l) => formatoHora(l.inicio2) },
    { titulo: 'Fim 2ª contagem', largura: 19, valor: (l) => formatoHora(l.fim2) },
    { titulo: 'Custo Unitário Médio s/ ICMS', largura: 14, valor: (l) => l.custoUnitario, numero: 'R$ #,##0.00' },
    { titulo: 'Custo Total da Contagem', largura: 15, valor: (l) => l.custoContagem, numero: 'R$ #,##0.00' },
    { titulo: 'Custo Total do Sistema', largura: 15, valor: (l) => l.custoSistema, numero: 'R$ #,##0.00' },
    { titulo: 'Situação', largura: 13, valor: (l) => (l.situacao === 'CONTADO' ? 'Contado' : 'Não contado') },
    { titulo: 'Fora do local', largura: 10, valor: (l) => (l.foraDoLocal ? 'Sim' : 'Não') },
    { titulo: 'Local na cópia', largura: 32, valor: (l) => l.locaisNaCopia.join(' · ') },
    { titulo: 'Qtd. 1ª contagem', largura: 11, valor: (l) => l.quantidade1, numero: '#,##0.###' },
    { titulo: 'Qtd. 2ª contagem', largura: 11, valor: (l) => l.quantidade2, numero: '#,##0.###' },
    { titulo: 'Recontagem', largura: 11, valor: (l) => ({ NAO: '', PENDENTE: 'Pendente', FEITA: 'Feita' })[l.recontagem] },
    { titulo: 'Loja', largura: 11, valor: (l) => l.empresa },
  ];

  const cabecalho = planilha.addRow(colunas.map((c) => c.titulo));
  cabecalho.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cabecalho.alignment = { vertical: 'middle', wrapText: true };
  cabecalho.height = 32;
  cabecalho.eachCell((celula) => {
    celula.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E3D' } };
  });
  const linhaCabecalho = cabecalho.number;

  for (const l of linhas) {
    const linha = planilha.addRow(colunas.map((c) => c.valor(l)));
    colunas.forEach((c, i) => {
      if (c.numero) linha.getCell(i + 1).numFmt = c.numero;
    });
    if (l.situacao === 'NAO_CONTADO') linha.font = { color: { argb: 'FF8A8F8E' } };
  }

  colunas.forEach((c, i) => {
    planilha.getColumn(i + 1).width = c.largura;
  });
  planilha.views = [{ state: 'frozen', ySplit: linhaCabecalho, xSplit: 2 }];
  planilha.autoFilter = { from: { row: linhaCabecalho, column: 1 }, to: { row: linhaCabecalho, column: colunas.length } };

  // Totais em dinheiro no rodapé — é a linha que a diretoria lê primeiro.
  const totalContagem = linhas.reduce((t, l) => t + (l.custoContagem ?? 0), 0);
  const totalSistema = linhas.reduce((t, l) => t + (l.custoSistema ?? 0), 0);
  const rodape = planilha.addRow(
    colunas.map((c) =>
      c.titulo === 'DESCPROD' ? 'TOTAL' : c.titulo === 'Custo Total da Contagem' ? totalContagem : c.titulo === 'Custo Total do Sistema' ? totalSistema : null
    )
  );
  rodape.font = { bold: true };
  colunas.forEach((c, i) => {
    if (c.numero) rodape.getCell(i + 1).numFmt = c.numero;
  });

  const seguro = contagem.nome.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\w-]+/g, '-').replace(/-+/g, '-');
  return { buffer: await workbook.xlsx.writeBuffer(), nomeArquivo: `${seguro || 'contagem'}.xlsx` };
}

export async function fotoDoRegistro(registroId: string) {
  const registro = await prisma.contagemLivreRegistro.findUnique({ where: { id: registroId }, select: { fotoChave: true } });
  if (!registro?.fotoChave) return null;
  return obterFotoStream(registro.fotoChave);
}

import ExcelJS from 'exceljs';

import { empresaDaFilial, filialDoLocal, labelFilial, localVisivelPara } from '../lib/filiais';
import { registrarLog } from '../lib/logAcao';
import { prisma } from '../lib/prisma';
import { buscarProdutosSankhya } from '../sankhya/client';
import { getLocalSankhya } from '../sankhya/copiaEstoque';
import { executarQuery } from '../sankhya/gateway';
import { resolverProdutoDoBipe } from './contagem.service';

// Validar locais (pedido de 20/10/2026).
//
//   bipa o local → bipa os produtos, um atrás do outro → finaliza
//
// Cada produto é conferido na hora contra o saldo ATUAL do Sankhya (TGFEST):
// tem saldo neste local = no lugar; tem saldo só em outro = fora do local
// (e diz onde); sem saldo em lugar nenhum da loja = sem saldo. O "local
// padrão" do cadastro (TGFPRO.CODLOCALPADRAO) não serve: em 20/10, 99% dos
// produtos apontavam pro "GERAL" da loja.
//
// Não conta quantidade e não toca em contagem nenhuma.

export class ErroValidacao extends Error {
  constructor(mensagem: string, readonly codigo = 'INVALIDO') {
    super(mensagem);
  }
}

type Situacao = 'NO_LOCAL' | 'FORA_DO_LOCAL' | 'SEM_SALDO';

export interface ItemValidacaoDTO {
  id: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  situacao: Situacao;
  locaisComSaldo: string[];
  bipadoEm: string;
}

export interface ProdutoEsperado {
  codigoProduto: string;
  descricao: string;
  unidade: string;
}

export interface ValidacaoDTO {
  id: string;
  localCodigo: string;
  local: string;
  iniciadaEm: string;
  finalizadaEm: string | null;
  itens: ItemValidacaoDTO[];
  // `esperados` = SKUs com saldo no local; `doLocal` = quantos deles já foram
  // bipados. Aqui não é contagem cega: saber quantos faltam é o objetivo.
  resumo: { bipados: number; noLocal: number; foraDoLocal: number; semSaldo: number; esperados: number; doLocal: number };
  // Só depois de finalizar: os SKUs do local que ninguém bipou.
  naoBipados: ProdutoEsperado[];
}

export type BipeValidacaoDTO =
  | { status: 'OK'; item: ItemValidacaoDTO; repetido: boolean; resumo?: ValidacaoDTO['resumo'] }
  | { status: 'VARIOS'; produtos: { codigoProduto: string; descricao: string; unidade: string }[] }
  | { status: 'ETIQUETA_DE_LOCAL'; localCodigo: string; local: string }
  | { status: 'NAO_IDENTIFICADO'; mensagem: string };

const SEPARADOR = ' · ';

async function usuarioAtivo(usuarioId: string) {
  const u = await prisma.usuario.findUnique({ where: { id: usuarioId } });
  if (!u || !u.ativo) throw new ErroValidacao('Login desativado.', 'NAO_AUTORIZADO');
  return u;
}

function itemDTO(i: { id: string; codigoProduto: string; descricao: string; unidade: string; situacao: Situacao; locaisComSaldo: string | null; bipadoEm: Date }): ItemValidacaoDTO {
  return {
    id: i.id,
    codigoProduto: i.codigoProduto,
    descricao: i.descricao,
    unidade: i.unidade,
    situacao: i.situacao,
    locaisComSaldo: i.locaisComSaldo ? i.locaisComSaldo.split(SEPARADOR) : [],
    bipadoEm: i.bipadoEm.toISOString(),
  };
}

// O Prisma tipa Json como objeto genérico: a lista vai como valor JSON.
const comoJson = (l: ProdutoEsperado[]) => l.map((e) => ({ ...e }));
const lerEsperados = (j: unknown): ProdutoEsperado[] => (Array.isArray(j) ? (j as ProdutoEsperado[]) : []);

function resumoDe(itens: { situacao: Situacao; codigoProduto: string }[], esperados: ProdutoEsperado[]) {
  const doLocal = new Set(esperados.map((e) => e.codigoProduto));
  return {
    bipados: itens.length,
    noLocal: itens.filter((i) => i.situacao === 'NO_LOCAL').length,
    foraDoLocal: itens.filter((i) => i.situacao === 'FORA_DO_LOCAL').length,
    semSaldo: itens.filter((i) => i.situacao === 'SEM_SALDO').length,
    esperados: esperados.length,
    doLocal: itens.filter((i) => doLocal.has(i.codigoProduto)).length,
  };
}

const naoBipadosDe = (itens: { codigoProduto: string }[], esperados: ProdutoEsperado[]) => {
  const bipados = new Set(itens.map((i) => i.codigoProduto));
  return esperados.filter((e) => !bipados.has(e.codigoProduto));
};

async function validacaoDTO(id: string): Promise<ValidacaoDTO> {
  const v = await prisma.validacaoLocal.findUniqueOrThrow({ where: { id }, include: { itens: { orderBy: { bipadoEm: 'desc' } } } });
  const esperados = lerEsperados(v.esperados);
  return {
    id: v.id,
    localCodigo: v.localCodigo,
    local: v.local,
    iniciadaEm: v.iniciadaEm.toISOString(),
    finalizadaEm: v.finalizadaEm?.toISOString() ?? null,
    itens: v.itens.map(itemDTO),
    resumo: resumoDe(v.itens, esperados),
    naoBipados: v.finalizadaEm ? naoBipadosDe(v.itens, esperados) : [],
  };
}

// Os SKUs com saldo no local agora, pelo Sankhya (TGFEST quebra por lote: soma).
async function esperadosNoLocal(localCodigo: string, empresa: string | null): Promise<ProdutoEsperado[]> {
  if (!/^\d+$/.test(localCodigo)) return [];
  const filtroEmpresa = empresa && /^\d+$/.test(empresa) ? `AND EST.CODEMP = ${Number(empresa)}` : '';
  const linhas = await executarQuery<{ codigoProduto: number; descricao: string | null; unidade: string | null }>(`
    SELECT EST.CODPROD AS "codigoProduto", MAX(PRO.DESCRPROD) AS "descricao", MAX(PRO.CODVOL) AS "unidade"
    FROM TGFEST EST
    INNER JOIN TGFPRO PRO ON PRO.CODPROD = EST.CODPROD
    WHERE EST.CODLOCAL = ${Number(localCodigo)} ${filtroEmpresa}
    GROUP BY EST.CODPROD
    HAVING SUM(NVL(EST.ESTOQUE, 0)) > 0
    ORDER BY MAX(PRO.DESCRPROD)
  `);
  return linhas.map((l) => ({ codigoProduto: String(l.codigoProduto), descricao: l.descricao ?? String(l.codigoProduto), unidade: l.unidade ?? '' }));
}

// Onde o Sankhya tem saldo do produto agora, na loja do local (TGFEST
// quebra por lote: soma). Sem `<>` no SQL: o gateway engole a consulta.
async function locaisComSaldo(codigoProduto: string, empresa: string | null) {
  if (!/^\d+$/.test(codigoProduto)) return [];
  const filtroEmpresa = empresa && /^\d+$/.test(empresa) ? `AND EST.CODEMP = ${Number(empresa)}` : '';
  const linhas = await executarQuery<{ localCodigo: number; local: string | null; saldo: number }>(`
    SELECT EST.CODLOCAL AS "localCodigo", MAX(LOC.DESCRLOCAL) AS "local", SUM(NVL(EST.ESTOQUE, 0)) AS "saldo"
    FROM TGFEST EST
    LEFT JOIN TGFLOC LOC ON LOC.CODLOCAL = EST.CODLOCAL
    WHERE EST.CODPROD = ${Number(codigoProduto)} ${filtroEmpresa}
    GROUP BY EST.CODLOCAL
    HAVING SUM(NVL(EST.ESTOQUE, 0)) > 0
    ORDER BY SUM(NVL(EST.ESTOQUE, 0)) DESC
  `);
  return linhas.map((l) => ({ localCodigo: String(l.localCodigo), local: l.local ?? String(l.localCodigo) }));
}

export async function estadoValidacao(usuarioId: string): Promise<{
  aberta: ValidacaoDTO | null;
  ultima: { local: string; finalizadaEm: string; resumo: ValidacaoDTO['resumo']; naoBipados: ProdutoEsperado[] } | null;
}> {
  const usuario = await usuarioAtivo(usuarioId);
  const aberta = await prisma.validacaoLocal.findFirst({ where: { usuarioId: usuario.id, finalizadaEm: null }, orderBy: { iniciadaEm: 'desc' } });
  const ultima = await prisma.validacaoLocal.findFirst({
    where: { usuarioId: usuario.id, finalizadaEm: { not: null } },
    orderBy: { finalizadaEm: 'desc' },
    include: { itens: { select: { situacao: true, codigoProduto: true } } },
  });
  const esperadosUltima = lerEsperados(ultima?.esperados);
  return {
    aberta: aberta ? await validacaoDTO(aberta.id) : null,
    ultima: ultima?.finalizadaEm
      ? {
          local: ultima.local,
          finalizadaEm: ultima.finalizadaEm.toISOString(),
          resumo: resumoDe(ultima.itens, esperadosUltima),
          naoBipados: naoBipadosDe(ultima.itens, esperadosUltima),
        }
      : null,
  };
}

export async function abrirValidacao(usuarioId: string, codigoLocal: string): Promise<ValidacaoDTO> {
  const usuario = await usuarioAtivo(usuarioId);
  const codigo = codigoLocal.trim();
  if (!/^\d{1,12}$/.test(codigo)) throw new ErroValidacao('Isso não é uma etiqueta de local. Bipe a etiqueta da prateleira.', 'NAO_E_LOCAL');
  if (!localVisivelPara(codigo, usuario.filial)) throw new ErroValidacao(`Esse local não é da loja ${labelFilial(usuario.filial)}.`, 'OUTRA_LOJA');

  const aberta = await prisma.validacaoLocal.findFirst({ where: { usuarioId: usuario.id, finalizadaEm: null } });
  if (aberta?.localCodigo === codigo) return validacaoDTO(aberta.id);

  let doSankhya;
  try {
    doSankhya = await getLocalSankhya(codigo);
  } catch {
    throw new ErroValidacao('Não consegui confirmar esse local no Sankhya agora. Tente de novo.', 'SANKHYA');
  }
  if (!doSankhya) throw new ErroValidacao('Etiqueta não reconhecida. Bipe a etiqueta da prateleira.', 'NAO_E_LOCAL');

  // Um local de cada vez: abrir outro finaliza o anterior.
  if (aberta) await finalizarValidacao(usuario.id, aberta.id);

  const empresa = empresaDaFilial(filialDoLocal(codigo));
  let esperados: ProdutoEsperado[];
  try {
    esperados = await esperadosNoLocal(codigo, empresa);
  } catch {
    throw new ErroValidacao('Não consegui ler os produtos do local no Sankhya agora. Tente de novo.', 'SANKHYA');
  }
  const nova = await prisma.validacaoLocal.create({
    data: { usuarioId: usuario.id, localCodigo: codigo, local: doSankhya.local, empresaCodigo: empresa, esperados: comoJson(esperados) },
  });
  void registrarLog(usuario.id, 'VALIDACAO_INICIADA', `Começou a validar ${doSankhya.local}.`, { validacaoId: nova.id, localCodigo: codigo });
  return validacaoDTO(nova.id);
}

async function validacaoAbertaDe(usuarioId: string, validacaoId: string) {
  const v = await prisma.validacaoLocal.findUnique({ where: { id: validacaoId } });
  if (!v || v.usuarioId !== usuarioId) throw new ErroValidacao('Validação não encontrada.', 'NAO_ENCONTRADA');
  if (v.finalizadaEm) throw new ErroValidacao('Essa validação já foi finalizada. Bipe o local de novo para começar outra.', 'FINALIZADA');
  return v;
}

// Quais produtos o código pode ser: o que o Sankhya diz (código de barras,
// CODPROD) e o que bipes anteriores da contagem e da validação ensinaram.
async function candidatos(lido: string) {
  const [resposta, daContagem, daValidacao] = await Promise.all([
    resolverProdutoDoBipe(lido),
    prisma.contagemLivreRegistro.findMany({ where: { codigoBipado: lido }, select: { codigoProduto: true, descricao: true, unidade: true }, distinct: ['codigoProduto'], take: 10 }),
    prisma.validacaoLocalItem.findMany({ where: { codigoBipado: lido }, select: { codigoProduto: true, descricao: true, unidade: true }, distinct: ['codigoProduto'], take: 10 }),
  ]);
  const porCodigo = new Map<string, { codigoProduto: string; descricao: string; unidade: string }>();
  for (const p of resposta.produtos) porCodigo.set(p.codigoProduto, { codigoProduto: p.codigoProduto, descricao: p.descricao, unidade: p.unidade });
  for (const p of [...daContagem, ...daValidacao]) if (!porCodigo.has(p.codigoProduto)) porCodigo.set(p.codigoProduto, p);
  return { lista: [...porCodigo.values()], etiqueta: resposta.ehEtiquetaDeLocal };
}

export async function biparNaValidacao(input: { usuarioId: string; validacaoId: string; codigo?: string; codigoProduto?: string }): Promise<BipeValidacaoDTO> {
  const usuario = await usuarioAtivo(input.usuarioId);
  const v = await validacaoAbertaDe(usuario.id, input.validacaoId);
  const lido = input.codigo?.trim() ?? '';

  let produto: { codigoProduto: string; descricao: string; unidade: string } | undefined;
  if (input.codigoProduto?.trim()) {
    const alvo = input.codigoProduto.trim();
    produto = (await buscarProdutosSankhya(alvo)).find((p) => p.codigoProduto === alvo);
    if (!produto) return { status: 'NAO_IDENTIFICADO', mensagem: 'Produto não encontrado no Sankhya.' };
  } else {
    if (!lido) return { status: 'NAO_IDENTIFICADO', mensagem: 'Nenhum código lido.' };
    const { lista, etiqueta } = await candidatos(lido);
    if (lista.length === 0) {
      // Etiqueta de outro local no lugar do produto: o jeito natural de ir pro próximo.
      const local = etiqueta || /^\d{1,12}$/.test(lido) ? await getLocalSankhya(lido).catch(() => null) : null;
      if (local) return { status: 'ETIQUETA_DE_LOCAL', localCodigo: local.localCodigo, local: local.local };
      return { status: 'NAO_IDENTIFICADO', mensagem: 'Código não identificado. Procure o produto pelo nome ou pelo SKU.' };
    }
    if (lista.length > 1) return { status: 'VARIOS', produtos: lista };
    produto = lista[0];
  }

  const ja = await prisma.validacaoLocalItem.findUnique({ where: { validacaoId_codigoProduto: { validacaoId: v.id, codigoProduto: produto.codigoProduto } } });
  if (ja) return { status: 'OK', item: itemDTO(ja), repetido: true, resumo: (await validacaoDTO(v.id)).resumo };

  let comSaldo;
  try {
    comSaldo = await locaisComSaldo(produto.codigoProduto, v.empresaCodigo);
  } catch {
    throw new ErroValidacao('Não consegui consultar o saldo no Sankhya agora. Bipe de novo.', 'SANKHYA');
  }
  const aqui = comSaldo.some((l) => l.localCodigo === v.localCodigo) || lerEsperados(v.esperados).some((e) => e.codigoProduto === produto.codigoProduto);
  const situacao: Situacao = aqui ? 'NO_LOCAL' : comSaldo.length > 0 ? 'FORA_DO_LOCAL' : 'SEM_SALDO';
  const outros = comSaldo.filter((l) => l.localCodigo !== v.localCodigo).slice(0, 5).map((l) => l.local);

  let item;
  try {
    item = await prisma.validacaoLocalItem.create({
      data: {
        validacaoId: v.id,
        codigoProduto: produto.codigoProduto,
        descricao: produto.descricao,
        unidade: produto.unidade ?? '',
        codigoBipado: lido || null,
        situacao,
        locaisComSaldo: situacao === 'FORA_DO_LOCAL' ? outros.join(SEPARADOR) : null,
      },
    });
  } catch (erro) {
    // Dois bipes do mesmo produto no mesmo instante: vale o primeiro.
    if ((erro as { code?: string }).code !== 'P2002') throw erro;
    const existente = await prisma.validacaoLocalItem.findUniqueOrThrow({ where: { validacaoId_codigoProduto: { validacaoId: v.id, codigoProduto: produto.codigoProduto } } });
    return { status: 'OK', item: itemDTO(existente), repetido: true, resumo: (await validacaoDTO(v.id)).resumo };
  }
  if (situacao === 'FORA_DO_LOCAL') {
    void registrarLog(usuario.id, 'VALIDACAO_FORA_DO_LOCAL', `Achou ${produto.descricao} em ${v.local}; o saldo está em ${outros.join(', ')}.`, {
      validacaoId: v.id,
      localCodigo: v.localCodigo,
      codigoProduto: produto.codigoProduto,
    });
  }
  return { status: 'OK', item: itemDTO(item), repetido: false, resumo: (await validacaoDTO(v.id)).resumo };
}

export async function removerItemValidacao(usuarioId: string, itemId: string) {
  const usuario = await usuarioAtivo(usuarioId);
  const item = await prisma.validacaoLocalItem.findUnique({ where: { id: itemId }, include: { validacao: true } });
  if (!item || item.validacao.usuarioId !== usuario.id) throw new ErroValidacao('Item não encontrado.', 'NAO_ENCONTRADA');
  if (item.validacao.finalizadaEm) throw new ErroValidacao('A validação já foi finalizada.', 'FINALIZADA');
  await prisma.validacaoLocalItem.delete({ where: { id: item.id } });
}

export async function finalizarValidacao(usuarioId: string, validacaoId: string): Promise<ValidacaoDTO> {
  const usuario = await usuarioAtivo(usuarioId);
  const v = await prisma.validacaoLocal.findUnique({ where: { id: validacaoId }, include: { itens: { select: { situacao: true, codigoProduto: true } } } });
  if (!v || v.usuarioId !== usuario.id) throw new ErroValidacao('Validação não encontrada.', 'NAO_ENCONTRADA');
  if (!v.finalizadaEm) {
    // Validação aberta antes do #355 não tem a lista: lê agora (sem ela, sem "não bipados").
    let esperados = Array.isArray(v.esperados) ? lerEsperados(v.esperados) : null;
    if (!esperados) esperados = await esperadosNoLocal(v.localCodigo, v.empresaCodigo).catch(() => []);
    await prisma.validacaoLocal.update({ where: { id: v.id }, data: { finalizadaEm: new Date(), esperados: comoJson(esperados) } });
    const r = resumoDe(v.itens, esperados);
    const faltam = naoBipadosDe(v.itens, esperados);
    void registrarLog(
      usuario.id,
      'VALIDACAO_FINALIZADA',
      `Finalizou a validação de ${v.local}: ${r.bipados} ${r.bipados === 1 ? 'produto bipado' : 'produtos bipados'} (${r.doLocal} de ${r.esperados} SKUs do local), ${r.foraDoLocal} fora do local, ${r.semSaldo} sem saldo, ${faltam.length} não bipados.`,
      { validacaoId: v.id, localCodigo: v.localCodigo, ...r, naoBipados: faltam.map((f) => f.codigoProduto), leituras: v.itens.map((i) => i.codigoProduto) }
    );
  }
  return validacaoDTO(v.id);
}

// ---- Gestor ------------------------------------------------------------------

export interface FiltroValidacao {
  de?: Date;
  ate?: Date;
  somenteForaDoLocal?: boolean;
}

export async function listarValidacoes(filtro: FiltroValidacao) {
  const lista = await prisma.validacaoLocal.findMany({
    where: { iniciadaEm: { gte: filtro.de, lte: filtro.ate } },
    include: { usuario: { select: { nome: true } }, itens: { orderBy: { bipadoEm: 'asc' } } },
    orderBy: { iniciadaEm: 'desc' },
    // Sem limite: com "take: 500" o painel mostrava só as 500 validações mais
    // recentes e as antigas sumiam da tela (o Excel, sem limite, tinha tudo).
    // O período escolhido no painel é o que segura o tamanho.
  });
  return lista.map((v) => ({
    id: v.id,
    localCodigo: v.localCodigo,
    local: v.local,
    usuario: v.usuario.nome,
    iniciadaEm: v.iniciadaEm.toISOString(),
    finalizadaEm: v.finalizadaEm?.toISOString() ?? null,
    resumo: resumoDe(v.itens, lerEsperados(v.esperados)),
    itens: v.itens.map(itemDTO),
    naoBipados: v.finalizadaEm ? naoBipadosDe(v.itens, lerEsperados(v.esperados)) : [],
  }));
}

// Um formatador só: criar um por célula pesa no Excel.
const dataHoraSP = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'medium' });
const hora = (d: Date | null) => (d ? dataHoraSP.format(d) : '');
const SITUACAO_TEXTO: Record<Situacao, string> = { NO_LOCAL: 'No local', FORA_DO_LOCAL: 'Fora do local', SEM_SALDO: 'Sem saldo no sistema' };

export async function gerarValidacaoXlsx(filtro: FiltroValidacao) {
  const lista = await prisma.validacaoLocal.findMany({
    where: { iniciadaEm: { gte: filtro.de, lte: filtro.ate } },
    include: { usuario: { select: { nome: true } }, itens: { orderBy: { bipadoEm: 'asc' } } },
    orderBy: { iniciadaEm: 'desc' },
  });
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Validação de locais');
  ws.addRow(['Validação de locais']).font = { bold: true, size: 14 };
  ws.addRow([`Gerado em ${hora(new Date())}${filtro.somenteForaDoLocal ? ' · só fora do local' : ''}`]);
  ws.addRow([]);
  const colunas: [string, number][] = [
    ['CODLOCAL', 11], ['DESCLOCAL', 32], ['Usuário', 20], ['Início', 19], ['Fim', 19],
    ['CODPROD', 11], ['DESCPROD', 44], ['Unidade', 9], ['Situação', 18], ['Locais com saldo no Sankhya', 44], ['Bipado em', 19],
  ];
  const cab = ws.addRow(colunas.map((c) => c[0]));
  cab.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  cab.eachCell((c) => (c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E3D' } }));
  colunas.forEach((c, i) => (ws.getColumn(i + 1).width = c[1]));
  for (const v of lista) {
    for (const i of v.itens) {
      if (filtro.somenteForaDoLocal && i.situacao !== 'FORA_DO_LOCAL') continue;
      const linha = ws.addRow([
        Number(v.localCodigo) || v.localCodigo, v.local, v.usuario.nome, hora(v.iniciadaEm), hora(v.finalizadaEm),
        Number(i.codigoProduto) || i.codigoProduto, i.descricao, i.unidade, SITUACAO_TEXTO[i.situacao], i.locaisComSaldo ?? '', hora(i.bipadoEm),
      ]);
      if (i.situacao === 'FORA_DO_LOCAL') linha.getCell(9).font = { bold: true, color: { argb: 'FFD1372F' } };
    }
    // Os SKUs que o Sankhya tem no local e ninguém bipou (chamado #355).
    if (filtro.somenteForaDoLocal || !v.finalizadaEm) continue;
    for (const n of naoBipadosDe(v.itens, lerEsperados(v.esperados))) {
      const linha = ws.addRow([
        Number(v.localCodigo) || v.localCodigo, v.local, v.usuario.nome, hora(v.iniciadaEm), hora(v.finalizadaEm),
        Number(n.codigoProduto) || n.codigoProduto, n.descricao, n.unidade, 'Não bipado', '', '',
      ]);
      linha.getCell(9).font = { bold: true, color: { argb: 'FFC9820A' } };
    }
  }
  ws.views = [{ state: 'frozen', ySplit: 4 }];
  return wb.xlsx.writeBuffer();
}

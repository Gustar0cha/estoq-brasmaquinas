import { formatarDiaReferencia, hojeBrasil, inicioDoDiaBrasil } from '../lib/datas';
import { ehFilial, localVisivelPara, prefixoDaFilial } from '../lib/filiais';
import { validarFotoContagem } from '../lib/fotoContagem';
import { uploadFotoContagem } from '../lib/minio';
import { prisma } from '../lib/prisma';
import { parsearLocalizacao } from '../sankhya/localizacao';
import { bipeIdentificaProduto } from './contagem.service';
import { agruparPorProdutoLocal, montarDTOs, ItemAgrupadoDTO, EnviarConferenciaItemInput } from './itemConferencia.service';

export const CAPACIDADES_FLUXO_LIVRE = {
  contagemLivre: true, movimentacaoLivre: true, fotoOpcional: true, localOpcional: true,
};

// `contagemPorCopia` diz ao app que a contagem contra a cópia de estoque
// (/contagem-livre) está pronta. Depende de DUAS coisas que chegam separadas:
// o código (deploy) e as tabelas (migrações 20261001000000_contagem_livre e
// 20261002000000_logs_quarentena_locais, que o deploy não aplica sozinho).
// Confere a tabela MAIS NOVA que o código usa a cada bipe: o dono do item. Anunciar só pelo código faria o celular abrir
// a tela nova contra tabelas que não existem. Então pergunta ao banco.
let tabelasProntas = false;
let conferidoEm = 0;
export async function contagemPorCopiaDisponivel(): Promise<boolean> {
  if (tabelasProntas || Date.now() - conferidoEm < 60_000) return tabelasProntas;
  conferidoEm = Date.now();
  try {
    const [linha] = await prisma.$queryRaw<{ ok: boolean }[]>`
      SELECT to_regclass('public.contagem_livre_item_donos') IS NOT NULL AS ok`;
    tabelasProntas = Boolean(linha?.ok);
  } catch {
    tabelasProntas = false;
  }
  return tabelasProntas;
}

export function tarefaMovimentacaoHoje(): string {
  return `mov-diaria-livre:${formatarDiaReferencia(hojeBrasil())}`;
}

// Muitos aparelhos abrem a aba ao mesmo tempo. Compartilhar por 30 segundos
// a consulta do dia evita repetir a mesma leitura pesada no Sankhya.
let cacheLista: { dia: string; expiraEm: number; consulta: ReturnType<typeof agruparPorProdutoLocal> } | null = null;
function gruposDaListaHoje() {
  const diaReferencia = hojeBrasil();
  const dia = formatarDiaReferencia(diaReferencia);
  if (cacheLista?.dia === dia && cacheLista.expiraEm > Date.now()) return cacheLista.consulta;
  const consulta = agruparPorProdutoLocal({ diaReferencia });
  cacheLista = { dia, expiraEm: Date.now() + 30_000, consulta };
  void consulta.catch(() => { if (cacheLista?.consulta === consulta) cacheLista = null; });
  return consulta;
}

async function usuarioAtivo(usuarioId: string) {
  const usuario = await prisma.usuario.findUnique({ where: { id: usuarioId }, select: { filial: true, ativo: true } });
  if (!usuario?.ativo) throw new Error('Usuário não autorizado.');
  return usuario;
}

export interface MovimentacaoLivreDTO {
  chave: string;
  tarefaId: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  local: string;
  status: 'PENDENTE' | 'CONTADA';
}

export async function getMovimentacaoLivreHoje(usuarioId: string): Promise<MovimentacaoLivreDTO[]> {
  const usuario = await usuarioAtivo(usuarioId);
  const tarefaId = tarefaMovimentacaoHoje();
  const grupos = new Map(await gruposDaListaHoje());
  if (tarefaId !== tarefaMovimentacaoHoje()) return getMovimentacaoLivreHoje(usuarioId);
  for (const [chave, grupo] of grupos) {
    if (!localVisivelPara(grupo.localCodigo, usuario.filial)) grupos.delete(chave);
  }
  return (await montarDTOs(grupos, tarefaId)).map((item) => ({
    chave: item.chave, tarefaId, codigoProduto: item.codigoProduto,
    descricao: item.descricao, unidade: item.unidade, local: item.local,
    status: item.quantidadeConferida === null ? 'PENDENTE' : 'CONTADA',
  }));
}

// O id por dia faz parte da chave única do resultado. Dois aparelhos podem
// escolher o mesmo item, mas o segundo envio nunca sobrescreve o primeiro.
export async function enviarMovimentacaoLivre(input: EnviarConferenciaItemInput): Promise<MovimentacaoLivreDTO> {
  if (input.tarefaId !== tarefaMovimentacaoHoje()) {
    throw new Error('O dia mudou. Atualize a lista de movimentações antes de contar.');
  }
  if (!Number.isSafeInteger(input.quantidadeConferida) || input.quantidadeConferida < 0) {
    throw new Error('Informe uma quantidade inteira maior ou igual a zero.');
  }
  validarFotoContagem(input.foto);
  const usuario = await usuarioAtivo(input.conferidoPorId);
  const grupos = await agruparPorProdutoLocal({ diaReferencia: hojeBrasil() });
  const grupo = grupos.get(input.chave);
  if (!grupo || !localVisivelPara(grupo.localCodigo, usuario.filial)) {
    throw new Error('Este produto não tem movimentação hoje na sua loja. Atualize a lista.');
  }
  // O local é evidência opcional, não mais uma trava para a operação.
  // Só impedimos uma etiqueta de outra filial.
  if (input.codigoLocalBipado?.trim() && !localVisivelPara(input.codigoLocalBipado.trim(), usuario.filial)) {
    throw new Error('O local bipado não pertence à sua loja.');
  }
  if (input.codigoProdutoBipado?.trim() && !(await bipeIdentificaProduto(input.codigoProdutoBipado, grupo.codigoProduto))) {
    throw new Error('O código bipado não corresponde ao produto escolhido.');
  }
  const tarefaId = input.tarefaId;
  const identidade = { chave: input.chave, numeroContagem: 1, tarefaId };
  const existente = await prisma.itemConferenciaResultado.findUnique({ where: { chave_numeroContagem_tarefaId: identidade } });
  if (existente && (existente.conferidoPorId !== input.conferidoPorId || existente.quantidadeConferida !== input.quantidadeConferida)) {
    throw new Error('Este item já foi contado hoje. Atualize a lista.');
  }
  if (!existente) {
    await prisma.tarefa.upsert({
      where: { id: tarefaId }, update: {},
      create: { id: tarefaId, nome: `Movimentação diária · ${formatarDiaReferencia(hojeBrasil())}`, tipo: 'MOV_DIARIA', diaReferencia: inicioDoDiaBrasil(hojeBrasil()), criadaPorId: input.conferidoPorId },
    });
    const fotoChaveArmazenamento = input.foto
      ? await uploadFotoContagem(`${tarefaId}-${input.chave}`, 1, input.foto.buffer, input.foto.mimeType)
      : undefined;
    // Revalidar depois das chamadas externas evita gravar no dia anterior se
    // o operador enviou junto da virada de meia-noite em São Paulo.
    if (tarefaId !== tarefaMovimentacaoHoje()) throw new Error('O dia mudou. Atualize a lista.');
    const salvo = await prisma.itemConferenciaResultado.upsert({
      where: { chave_numeroContagem_tarefaId: identidade }, update: {},
      create: {
        ...identidade, empresaCodigo: grupo.empresaCodigo, codigoProduto: grupo.codigoProduto,
        descricao: grupo.descricao, local: grupo.local, localCodigo: grupo.localCodigo,
        quantidadeEsperada: grupo.quantidadeEsperada, quantidadeConferida: input.quantidadeConferida,
        diferenca: input.quantidadeConferida - grupo.quantidadeEsperada,
        conferidoPorId: input.conferidoPorId, dataConferencia: new Date(),
        codigoLocalBipado: input.codigoLocalBipado?.trim() || null,
        codigoProdutoBipado: input.codigoProdutoBipado?.trim() || null,
        observacao: input.observacao, fotoChaveArmazenamento,
      },
    });
    if (salvo.conferidoPorId !== input.conferidoPorId || salvo.quantidadeConferida !== input.quantidadeConferida) {
      throw new Error('Outro colaborador acabou de contar este item. Atualize a lista.');
    }
  }
  return { chave: input.chave, tarefaId, codigoProduto: grupo.codigoProduto,
    descricao: grupo.descricao, unidade: grupo.unidade, local: grupo.local, status: 'CONTADA' };
}

// Histórico é consultado no registro persistido, não nas notas de hoje.
// Assim um SKU contado em duas datas gera duas linhas independentes.
export async function getResultadosMovimentacao(filtro: { dataInicio?: Date; dataFim?: Date; usuarioId: string }): Promise<ItemAgrupadoDTO[]> {
  const usuario = await usuarioAtivo(filtro.usuarioId);
  const resultados = await prisma.itemConferenciaResultado.findMany({
    where: {
      ...(ehFilial(usuario.filial) ? { localCodigo: { startsWith: prefixoDaFilial(usuario.filial) } } : {}),
      ...(filtro.dataInicio || filtro.dataFim ? { dataConferencia: { gte: filtro.dataInicio, lte: filtro.dataFim } } : {}),
    },
    orderBy: { dataConferencia: 'desc' },
  });
  const mapa = new Map<string, ItemAgrupadoDTO>();
  for (const r of resultados) {
    // Antes das tarefas, tarefaId era nulo e o Postgres permite várias linhas
    // com NULL na chave composta. Não colapsar contagens de dias distintos.
    const chave = r.tarefaId ? `${r.tarefaId}|${r.chave}` : `legado|${r.id}`;
    let dto = mapa.get(chave);
    if (!dto) {
      dto = { chave: r.tarefaId ? r.chave : `${r.chave}|${r.id}`, tarefaId: r.tarefaId, empresaCodigo: r.empresaCodigo, empresaNome: r.empresaCodigo,
        codigoProduto: r.codigoProduto, descricao: r.descricao, unidade: '', local: r.local, localCodigo: r.localCodigo,
        ...parsearLocalizacao(r.local), marca: null, grupoCodigo: null, grupo: null,
        quantidadeEsperada: r.quantidadeEsperada, quantidadeEsperadaNaContagem: null, quantidadeConferida: null,
        diferenca: null, status: 'PENDENTE', atribuidoPara: null, notasOrigem: [], segundaContagemSolicitada: false };
      mapa.set(chave, dto);
    }
    if (r.numeroContagem === 1) Object.assign(dto, {
      quantidadeEsperadaNaContagem: r.quantidadeEsperada, quantidadeConferida: r.quantidadeConferida,
      diferenca: r.diferenca, motivo: r.motivo ?? undefined, observacao: r.observacao ?? undefined,
      comentarioAdmin: r.comentarioAdmin ?? undefined, dataConferencia: r.dataConferencia.toISOString(),
      conferidoPorId: r.conferidoPorId, temFoto: Boolean(r.fotoChaveArmazenamento),
    });
    else {
      // Se o recorte contém só a recontagem (ou um registro legado sem tarefa),
      // ela ainda precisa aparecer no relatório; não há primeiro resultado
      // dentro desse recorte para preencher o campo principal.
      if (dto.quantidadeConferida === null) Object.assign(dto, {
        quantidadeConferida: r.quantidadeConferida, quantidadeEsperadaNaContagem: r.quantidadeEsperada,
        diferenca: r.diferenca, conferidoPorId: r.conferidoPorId,
        dataConferencia: r.dataConferencia.toISOString(),
      });
      Object.assign(dto, { quantidadeConferida2: r.quantidadeConferida, quantidadeEsperadaNaContagem2: r.quantidadeEsperada,
        diferenca2: r.diferenca, conferidoPor2Id: r.conferidoPorId, dataConferencia2: r.dataConferencia.toISOString(), temFoto2: Boolean(r.fotoChaveArmazenamento) });
    }
  }
  return [...mapa.values()].map((dto) => ({ ...dto, status: (dto.diferenca2 ?? dto.diferenca) === 0 ? 'CONFERIDA' : 'DIVERGENCIA' }));
}

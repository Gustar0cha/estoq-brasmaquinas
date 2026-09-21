// Panorama do estoque: a visão de TUDO, não só do que já entrou em contagem.
//
// O painel sabia responder "quanto falta contar do que foi distribuído". Não
// sabia responder "quanto do estoque ainda nem foi distribuído" — que é a
// pergunta do gestor que precisa saber o tamanho do trabalho restante.
//
// Também sai daqui o relatório de produto espalhado: o mesmo SKU guardado em
// mais de um endereço da mesma rua. Isso atrapalha a contagem (a pessoa conta
// um endereço e o resto do saldo fica em outro) e costuma indicar
// endereçamento mal feito.

import { ehLocalPaiAgrupador } from '../lib/agrupadores';
import { ehLocalDeLoja } from '../lib/filiais';
import { prisma } from '../lib/prisma';
import { getSaldoCompleto } from '../sankhya/estoque';
import { resolverLocalizacao } from '../sankhya/localizacao';

export interface ResumoPanorama {
  skus: number;
  locais: number;
  // Combinações produto+local — a unidade de trabalho real da contagem.
  itens: number;
}

export interface RuaPanorama {
  rua: string | null;
  locais: number;
  locaisNaContagem: number;
  itens: number;
  itensNaContagem: number;
}

export interface ProdutoEspalhado {
  rua: string | null;
  codigoProduto: string;
  descricao: string;
  quantidadeTotal: number;
  locais: { localCodigo: string; local: string; quantidade: number }[];
}

export interface PanoramaEstoque {
  atualizadoEm: string;
  // Tudo que tem saldo no Sankhya hoje (fora quarentena e endereçamento antigo).
  estoque: ResumoPanorama;
  // O que está dentro da contagem aberta.
  naContagem: ResumoPanorama;
  // O que tem saldo e nunca foi atribuído a ninguém — o que falta distribuir.
  foraDaContagem: ResumoPanorama;
  porRua: RuaPanorama[];
  espalhados: ProdutoEspalhado[];
}

function chave(codigoProduto: string, localCodigo: string): string {
  return `${codigoProduto}|${localCodigo}`;
}

export async function getPanoramaEstoque(cicloId?: string): Promise<PanoramaEstoque> {
  const [linhas, itensEmContagem] = await Promise.all([
    getSaldoCompleto(),
    prisma.contagemItem.findMany({
      where: cicloId ? { cicloId } : {},
      select: { codigoProduto: true, localCodigo: true },
    }),
  ]);

  const naContagem = new Set(itensEmContagem.map((i) => chave(i.codigoProduto, i.localCodigo)));

  // Mesma peneira da atribuição: endereçamento antigo fora, senão o "falta
  // distribuir" viria inflado com prateleiras que a operação não usa mais.
  const relevantes = linhas.filter((l) => ehLocalDeLoja(l.localCodigo));

  const contarEm = (lista: typeof relevantes): ResumoPanorama => ({
    skus: new Set(lista.map((l) => l.codigoProduto)).size,
    locais: new Set(lista.map((l) => l.localCodigo)).size,
    itens: lista.length,
  });

  const dentro = relevantes.filter((l) => naContagem.has(chave(l.codigoProduto, l.localCodigo)));
  const fora = relevantes.filter((l) => !naContagem.has(chave(l.codigoProduto, l.localCodigo)));

  // --- por rua, pra mostrar onde está a maior parte do que falta ---
  const ruas = new Map<string, RuaPanorama & { _locais: Set<string>; _locaisContagem: Set<string> }>();
  // --- produto espalhado: agrupa por rua + produto ---
  const espalhadosMapa = new Map<
    string,
    { rua: string | null; codigoProduto: string; descricao: string; locais: Map<string, { local: string; quantidade: number }> }
  >();

  for (const linha of relevantes) {
    const { rua } = resolverLocalizacao(
      linha.local,
      { codigo: linha.localPaiCodigo, descricao: linha.localPai },
      ehLocalPaiAgrupador
    );
    const chaveRua = rua ?? '?';
    const estaNaContagem = naContagem.has(chave(linha.codigoProduto, linha.localCodigo));

    let resumoRua = ruas.get(chaveRua);
    if (!resumoRua) {
      resumoRua = {
        rua,
        locais: 0,
        locaisNaContagem: 0,
        itens: 0,
        itensNaContagem: 0,
        _locais: new Set(),
        _locaisContagem: new Set(),
      };
      ruas.set(chaveRua, resumoRua);
    }
    resumoRua.itens += 1;
    if (estaNaContagem) resumoRua.itensNaContagem += 1;
    resumoRua._locais.add(linha.localCodigo);
    if (estaNaContagem) resumoRua._locaisContagem.add(linha.localCodigo);

    const chaveEspalhado = `${chaveRua}|${linha.codigoProduto}`;
    let espalhado = espalhadosMapa.get(chaveEspalhado);
    if (!espalhado) {
      espalhado = {
        rua,
        codigoProduto: linha.codigoProduto,
        descricao: linha.descricao,
        locais: new Map(),
      };
      espalhadosMapa.set(chaveEspalhado, espalhado);
    }
    espalhado.locais.set(linha.localCodigo, { local: linha.local, quantidade: linha.quantidade });
  }

  const porRua: RuaPanorama[] = [...ruas.values()]
    .map((r) => ({
      rua: r.rua,
      locais: r._locais.size,
      locaisNaContagem: r._locaisContagem.size,
      itens: r.itens,
      itensNaContagem: r.itensNaContagem,
    }))
    .sort((a, b) => (a.rua ?? 'zzz').localeCompare(b.rua ?? 'zzz', 'pt-BR', { numeric: true }));

  const espalhados: ProdutoEspalhado[] = [...espalhadosMapa.values()]
    // Só rua de verdade: local sem rua é área solta (EXPEDIÇÃO, SERVIÇOS,
    // RECEBIMENTO...), e juntar todas num balde só chamaria de "mesma rua"
    // coisas que estão em cantos opostos do galpão.
    .filter((e) => e.rua !== null && e.locais.size > 1)
    .map((e) => ({
      rua: e.rua,
      codigoProduto: e.codigoProduto,
      descricao: e.descricao,
      // Somar float traz cauda binária (456.79999999999995).
      quantidadeTotal:
        Math.round([...e.locais.values()].reduce((t, l) => t + l.quantidade, 0) * 1000) / 1000,
      locais: [...e.locais.entries()]
        .map(([localCodigo, dados]) => ({ localCodigo, local: dados.local, quantidade: dados.quantidade }))
        .sort((a, b) => b.quantidade - a.quantidade),
    }))
    // Quem está em mais endereços primeiro: é o que mais atrapalha a contagem.
    .sort((a, b) => b.locais.length - a.locais.length || b.quantidadeTotal - a.quantidadeTotal);

  return {
    atualizadoEm: new Date().toISOString(),
    estoque: contarEm(relevantes),
    naContagem: contarEm(dentro),
    foraDaContagem: contarEm(fora),
    porRua,
    espalhados,
  };
}

// Parsing de TGFLOC.DESCRLOCAL em rua/prédio/nível, pra agrupar a contagem
// física por prédio (e, dentro dele, por nível). A descrição não é
// padronizada no Sankhya — coexistem pelo menos 3 esquemas (confirmados numa
// auditoria real, 2026-08-28):
//   - Por extenso: "RUA 4 PRÉDIO 2 NÍVEL 2 CESTO 16", "RUA-3-NIVEL-1-PREDIO-1-CESTO-28"
//   - Abreviado "A.A.": "A.A.R.3.L.A.P.4.N.2.AP.4", "A.A-R.4-L.B-P.4-N.1-G.I-02"
//   - Compacto: "R4P2N1", "R 4 - P 4 - N 1 - C 10"
// Confirmado com a equipe: o prefixo "A.A." é só outra forma de escrever a
// mesma coisa (R=Rua, P=Prédio, N=Nível, L=Lado A/B) — os dois esquemas
// contam igual pra agrupamento por prédio. Locais sem rua/prédio reconhecível
// (mostruário, áreas de recebimento, etc) retornam null nos campos e caem num
// agrupamento "Outros locais" na UI — nunca são descartados.

export interface LocalizacaoParseada {
  rua: string | null;
  predio: string | null;
  nivel: string | null;
}

// Extrai um número associado a uma palavra por extenso (ex: "RUA 4",
// "PRÉDIO 2", aceitando hífen/espaço como separador) — tentada primeiro.
function extrairPorExtenso(descricao: string, ...palavras: string[]): string | null {
  for (const palavra of palavras) {
    const padrao = new RegExp(`${palavra}\\s*-?\\s*([0-9]+)`);
    const match = descricao.match(padrao);
    if (match) return match[1];
  }
  return null;
}

// Extrai um número associado a uma letra isolada (ex: "R.3", "R-4", "R4"),
// só quando a letra não faz parte de outra palavra (o caractere anterior não
// pode ser uma letra — assim "AREA" ou "PAR.E" nunca batem com "R"/"P" soltos).
function extrairAbreviado(descricao: string, letra: string): string | null {
  const padrao = new RegExp(`(?:^|[^A-Z])${letra}[.\\-\\s]*([0-9]+)`);
  const match = descricao.match(padrao);
  return match ? match[1] : null;
}

export function parsearLocalizacao(descricaoLocal: string | null | undefined): LocalizacaoParseada {
  if (!descricaoLocal) return { rua: null, predio: null, nivel: null };
  const descricao = descricaoLocal.toUpperCase();

  const rua = extrairPorExtenso(descricao, 'RUA') ?? extrairAbreviado(descricao, 'R');
  const predio =
    extrairPorExtenso(descricao, 'PR[ÉE]DIO', 'BLOCO') ?? extrairAbreviado(descricao, 'P');
  const nivel = extrairPorExtenso(descricao, 'N[ÍI]VEL') ?? extrairAbreviado(descricao, 'N');

  return { rua, predio, nivel };
}

// Localização usada no agrupamento da contagem: o endereço lido do nome, a não
// ser que o local esteja dentro de um pai agrupador (ver lib/agrupadores.ts).
// Nesse caso o grupo é o próprio pai ("AUTO ATENDIMENTO") e a subdivisão é o
// local filho ("(AUTO) ILHA 1"), mesmo que o nome do filho pareça um endereço
// — o que vale é onde ele está na árvore do Sankhya.
export function resolverLocalizacao(
  descricaoLocal: string | null | undefined,
  pai: { codigo: string | null | undefined; descricao: string | null | undefined } | null | undefined,
  ehAgrupador: (codigoPai: string | null | undefined) => boolean
): LocalizacaoParseada {
  if (pai && ehAgrupador(pai.codigo) && pai.descricao) {
    return { rua: null, predio: pai.descricao.trim(), nivel: (descricaoLocal ?? '').trim() || null };
  }
  return parsearLocalizacao(descricaoLocal);
}

// Rótulo de um grupo pra mensagens: endereço ("Rua 2 Prédio 6") ou, pros
// agrupadores, só o nome da área ("AUTO ATENDIMENTO").
export function rotuloDoGrupo(rua: string | null, predio: string | null): string {
  if (!rua && !predio) return 'Outros locais';
  if (!rua) return /^[0-9]+$/.test(predio ?? '') ? `Prédio ${predio}` : (predio as string);
  return `Rua ${rua}${predio ? ` Prédio ${predio}` : ''}`;
}

// Subdivisão: número de nível ("Nível 2") ou, nos agrupadores, o nome do local.
export function rotuloDaSubdivisao(nivel: string | null): string {
  if (nivel === null) return 'Sem nível';
  return /^[0-9]+$/.test(nivel) ? `Nível ${nivel}` : nivel;
}

// Chave de agrupamento estável pra uma rua+prédio (usada tanto pra montar a
// lista de prédios disponíveis quanto pras colunas persistidas em
// ContagemItem) — null em qualquer um dos dois vira "outros locais na UI,
// nunca aqui: essa função só monta a chave, quem decide o agrupamento
// "outros" é a camada de serviço.
export function chavePredio(rua: string | null, predio: string | null): string {
  return `${rua ?? '?'}|${predio ?? '?'}`;
}

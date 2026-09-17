// Locais pai do Sankhya cujos filhos são contados como UMA área, e não pelo
// endereço escrito no nome de cada filho.
//
// Por que uma lista explícita e não uma regra automática ("local sem RUA no
// nome é agrupado pelo pai"): a regra automática desmontaria endereços reais.
// Em Janaúba os locais usam o formato compacto "P02A3" (sem rua) e são todos
// filhos de "GERAL" — agrupar pelo pai juntaria todos os prédios da loja num
// grupo só. Então só entra aqui o pai que de fato é uma área de contagem.
//
// Dentro de um agrupador, cada local filho vira a subdivisão (no lugar do
// nível), pra dar pra atribuir a área inteira ou um pedaço dela.
//
// Para incluir outra área: acrescente o CODLOCAL do pai (TGFLOC.CODLOCALPAI
// dos locais que ficam dentro dela).
export const LOCAIS_PAI_AGRUPADORES = new Set<string>([
  '297000', // 02.97.000 - AUTO ATENDIMENTO (Guanambi)
  '298000', // 02.98.000 - ÁREAS E SETORES (Guanambi)
]);

export function ehLocalPaiAgrupador(codigoPai: string | null | undefined): boolean {
  return !!codigoPai && LOCAIS_PAI_AGRUPADORES.has(String(codigoPai));
}

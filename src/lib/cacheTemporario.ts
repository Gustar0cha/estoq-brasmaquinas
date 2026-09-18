// Cache com validade curta para consultas ao Sankhya.
//
// O saldo da contagem passou a vir do estoque real (TGFEST), não mais da
// cópia diária — e o estoque real muda o tempo todo. Consultar o Sankhya a
// cada tela seria lento e é o tipo de rajada que faz o gateway recusar com
// "Não autorizado"; consultar uma vez por dia traria número velho. O meio do
// caminho é uma janela curta: dentro dela todo mundo lê o mesmo retrato.
//
// Chamadas simultâneas da mesma chave compartilham UMA consulta (a promessa
// entra no cache antes de resolver) — senão o primeiro acesso depois do
// vencimento dispara N consultas iguais de uma vez.

export const VALIDADE_SALDO_MS = 5 * 60 * 1000;

interface Entrada<T> {
  valor: Promise<T>;
  expiraEm: number;
}

const entradas = new Map<string, Entrada<unknown>>();

export async function comCache<T>(
  chave: string,
  validadeMs: number,
  produzir: () => Promise<T>
): Promise<T> {
  const agora = Date.now();
  const existente = entradas.get(chave) as Entrada<T> | undefined;
  if (existente && existente.expiraEm > agora) return existente.valor;

  const valor = produzir();
  entradas.set(chave, { valor, expiraEm: agora + validadeMs });

  try {
    return await valor;
  } catch (erro) {
    // Falha não fica em cache: a próxima chamada tenta de novo em vez de
    // repetir o erro por cinco minutos.
    if (entradas.get(chave)?.valor === valor) entradas.delete(chave);
    throw erro;
  }
}

// Usado quando a contagem precisa enxergar o efeito de algo que acabou de
// mudar no Sankhya, sem esperar a janela vencer.
export function limparCache(prefixo?: string): void {
  if (!prefixo) {
    entradas.clear();
    return;
  }
  for (const chave of entradas.keys()) {
    if (chave.startsWith(prefixo)) entradas.delete(chave);
  }
}

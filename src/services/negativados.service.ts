import { prisma } from '../lib/prisma';
import { FiltroProdutosNegativados, getProdutosNegativadosSankhya, ProdutoNegativadoSankhya } from '../sankhya/client';
import { criarNotificacao } from './notificacao.service';

export async function getProdutosNegativados(
  filtro?: FiltroProdutosNegativados
): Promise<ProdutoNegativadoSankhya[]> {
  return getProdutosNegativadosSankhya(filtro);
}

function montarChave(empresaCodigo: string, codigoProduto: string): string {
  return `${empresaCodigo}|${codigoProduto}`;
}

// Roda periodicamente (ver src/jobs/negativados.job.ts): compara os
// negativados de agora contra os já rastreados. Produto novo na lista ->
// notifica e passa a rastrear. Produto que sumiu da lista (voltou a ficar
// >= 0) -> para de rastrear, liberado pra notificar de novo se negativar
// outra vez. Produto que continua negativado -> não notifica de novo.
export async function verificarNovosProdutosNegativados(): Promise<{ novos: number }> {
  const negativados = await getProdutosNegativadosSankhya();
  const chavesAtuais = new Set(negativados.map((p) => montarChave(p.empresaCodigo, p.codigoProduto)));

  const rastreados = await prisma.produtoNegativadoRastreado.findMany();
  const chavesRastreadas = new Set(rastreados.map((r) => r.chave));

  const chavesRecuperadas = rastreados.filter((r) => !chavesAtuais.has(r.chave)).map((r) => r.chave);
  if (chavesRecuperadas.length > 0) {
    await prisma.produtoNegativadoRastreado.deleteMany({ where: { chave: { in: chavesRecuperadas } } });
  }

  const novos = negativados.filter((p) => !chavesRastreadas.has(montarChave(p.empresaCodigo, p.codigoProduto)));

  for (const produto of novos) {
    const chave = montarChave(produto.empresaCodigo, produto.codigoProduto);
    await prisma.produtoNegativadoRastreado.create({ data: { chave } }).catch(() => {});
    await criarNotificacao(
      'PRODUTO_NEGATIVADO',
      chave,
      'Produto com estoque negativo',
      `${produto.descricao} (${produto.empresaNome}): estoque ${produto.estoque}.`
    );
  }

  return { novos: novos.length };
}

import { Router } from 'express';
import { promisify } from 'node:util';
import { gunzipSync, gzip } from 'node:zlib';

import { autenticar, exigirGestor } from '../middleware/auth';
import { getCatalogoProdutos, getDetalheEstoqueProduto, LOJAS } from '../sankhya/consultaProdutos';

// Consulta de produtos no painel (gestor e administrador). Ver
// sankhya/consultaProdutos.ts.
export const consultaProdutosRouter = Router();

// O catálogo inteiro (~26 mil produtos) fica 10 minutos em memória, já em
// JSON comprimido: a busca e a ordenação acontecem no navegador, e o Sankhya
// é lido no máximo uma vez a cada 10 minutos, por mais gente que abra a tela.
const VALIDADE_MS = 10 * 60_000;
const comprimir = promisify(gzip);
let catalogo: { em: number; corpo: Promise<{ gz: Buffer; total: number; lidoEm: string }> } | null = null;

function catalogoComprimido(recarregar: boolean) {
  if (!recarregar && catalogo && Date.now() - catalogo.em < VALIDADE_MS) return catalogo.corpo;
  const corpo = (async () => {
    const produtos = await getCatalogoProdutos();
    const lidoEm = new Date().toISOString();
    return { gz: await comprimir(Buffer.from(JSON.stringify({ lidoEm, lojas: LOJAS, produtos }))), total: produtos.length, lidoEm };
  })();
  const entrada = { em: Date.now(), corpo };
  catalogo = entrada;
  // Erro não fica guardado: o próximo pedido tenta de novo.
  corpo.catch(() => {
    if (catalogo === entrada) catalogo = null;
  });
  return corpo;
}

consultaProdutosRouter.get('/', autenticar, exigirGestor, async (req, res) => {
  try {
    const { gz } = await catalogoComprimido(req.query.recarregar === 'true');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Vary', 'Accept-Encoding');
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      res.setHeader('Content-Encoding', 'gzip');
      res.send(gz);
    } else {
      res.send(gunzipSync(gz));
    }
  } catch (erro) {
    console.error('[consulta-produtos]', erro);
    res.status(503).json({ erro: 'Não consegui ler os produtos no Sankhya agora. Tente de novo em instantes.' });
  }
});

// Estoque por loja e local, e os pedidos que reservam: lido na hora.
consultaProdutosRouter.get('/:codigo', autenticar, exigirGestor, async (req, res) => {
  try {
    res.json(await getDetalheEstoqueProduto(String((req.params as { codigo: string }).codigo)));
  } catch (erro) {
    console.error('[consulta-produtos]', erro);
    res.status(503).json({ erro: 'Não consegui ler o estoque no Sankhya agora. Tente de novo.' });
  }
});

import { Router } from 'express';
import { promisify } from 'node:util';
import { gunzipSync, gzip } from 'node:zlib';

import { autenticar, exigirGestor } from '../middleware/auth';
import { getCatalogoProdutos, getDetalheEstoqueProduto, LOJAS, ProdutoConsulta } from '../sankhya/consultaProdutos';

// Consulta de produtos no painel e no app (gestor e administrador). Ver
// sankhya/consultaProdutos.ts.
export const consultaProdutosRouter = Router();

// O catálogo inteiro (~26 mil produtos) fica 10 minutos em memória: em JSON
// comprimido para o painel, que busca e ordena no navegador, e com o texto de
// busca de cada produto para o celular, que pede só os resultados. O Sankhya
// é lido no máximo uma vez a cada 10 minutos, por mais gente que abra a tela.
const VALIDADE_MS = 10 * 60_000;
const comprimir = promisify(gzip);

interface Catalogo {
  gz: Buffer;
  lidoEm: string;
  produtos: ProdutoConsulta[];
  alvos: string[];
}
let catalogo: { em: number; corpo: Promise<Catalogo> } | null = null;

const normal = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function lerCatalogo(recarregar: boolean) {
  if (!recarregar && catalogo && Date.now() - catalogo.em < VALIDADE_MS) return catalogo.corpo;
  const corpo = (async () => {
    const produtos = await getCatalogoProdutos();
    const lidoEm = new Date().toISOString();
    const alvos = produtos.map((p) => normal(`${p.descricao} ${p.codigo} ${p.referencia ?? ''} ${p.codigoBarras ?? ''} ${p.codigoJanauba ?? ''}`));
    return { gz: await comprimir(Buffer.from(JSON.stringify({ lidoEm, lojas: LOJAS, produtos }))), lidoEm, produtos, alvos };
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
    const { gz } = await lerCatalogo(req.query.recarregar === 'true');
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

// Busca do celular: as mesmas regras do painel (vários códigos separados por
// vírgula, ou todas as palavras na descrição/códigos), devolvendo no máximo
// LIMITE produtos. Código exato (bipado) vem primeiro.
const LIMITE = 50;
consultaProdutosRouter.get('/busca', autenticar, exigirGestor, async (req, res) => {
  try {
    const { produtos, alvos, lidoEm } = await lerCatalogo(req.query.recarregar === 'true');
    const texto = String(req.query.q ?? '').trim();
    const achados: ProdutoConsulta[] = [];
    let total = 0;
    if (texto) {
      const codigosDe = (p: ProdutoConsulta) => [p.codigo, p.referencia, p.codigoBarras, p.codigoJanauba];
      if (/[,;\n]/.test(texto)) {
        const codigos = new Set(texto.split(/[\n,;]+/).map((c) => normal(c.trim())).filter(Boolean));
        for (const p of produtos) {
          if (!codigosDe(p).some((c) => c && codigos.has(normal(c)))) continue;
          total++;
          if (achados.length < LIMITE) achados.push(p);
        }
      } else {
        const palavras = normal(texto).split(/\s+/).filter(Boolean);
        const exato = normal(texto);
        const exatos: ProdutoConsulta[] = [];
        for (let i = 0; i < produtos.length; i++) {
          if (!palavras.every((w) => alvos[i].includes(w))) continue;
          total++;
          const p = produtos[i];
          if (codigosDe(p).some((c) => c && normal(c) === exato)) exatos.push(p);
          else if (achados.length < LIMITE) achados.push(p);
        }
        achados.unshift(...exatos);
        achados.length = Math.min(achados.length, LIMITE);
      }
    }
    res.json({ lidoEm, total, produtos: achados });
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

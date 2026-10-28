import { executarQuery } from './gateway';

// Consulta de produtos (pedido de 26/10/2026): o que a tela "Consulta de
// Produtos" do Sankhya mostra, sem precisar entrar no Sankhya.
//
// A tela original monta UMA linha por produto com quatro subconsultas de
// estoque cada e chama a procedure de preço produto a produto. Aqui são
// poucas consultas grandes (produtos, estoque agrupado, preços), juntadas
// em memória: o gateway não aceita procedure e mil idas seriam lentas.

const PAGINA = 5000;

// As lojas como a tela do Sankhya mostra (CODEMP).
export const LOJAS = [
  { codigo: '1', nome: 'Guanambi' },
  { codigo: '2', nome: 'Lapa' },
  { codigo: '3', nome: 'LEM' },
  { codigo: '4', nome: 'Janaúba' },
] as const;

// As tabelas de preço da tela: 0 = PREÇO BALCÃO BAHIA, 1 = PREÇO REVENDA,
// 2 = REVENDA 2. A 1 e a 2 são DERIVADAS (TGFTAB.CODTABORIG + PERCENTUAL):
// em 26/10 a 1 vinha da 3 ("TABELA ZERADA", sem preço nenhum) e a 2 era a
// 1 + 15%. Por isso a revenda sai zerada, igual à tela do Sankhya.
const TABELAS = { balcao: 0, revenda: 1, revenda2: 2 } as const;

export interface ProdutoConsulta {
  codigo: string;
  codigoJanauba: string | null;
  descricao: string;
  referencia: string | null;
  unidade: string;
  codigoBarras: string | null;
  // Estoque e reservado por loja (CODEMP), somando os locais.
  estoque: Record<string, { total: number; reservado: number }>;
  // Local padrão do produto em cada loja (campos AD_ do cadastro).
  localPadrao: { guanambi: string | null; lapa: string | null; lem: string | null };
  precos: { balcao: number | null; revenda: number | null; revenda2: number | null };
}

async function paginado<T>(sql: (offset: number) => string): Promise<T[]> {
  const todas: T[] = [];
  for (let offset = 0; ; offset += PAGINA) {
    const pagina = await executarQuery<T>(sql(offset));
    todas.push(...pagina);
    if (pagina.length < PAGINA) break;
  }
  return todas;
}

// Preço de cada produto numa tabela, seguindo a regra do Sankhya: a versão
// vigente mais recente (TGFTAB); se ela não tem o produto em TGFEXC, vale a
// tabela de origem com o percentual.
async function precosPorTabela(): Promise<Record<keyof typeof TABELAS, Map<string, number>>> {
  const versoes = await executarQuery<{ codtab: number; nutab: number; percentual: number | null; origem: number | null }>(`
    SELECT T.CODTAB AS "codtab", T.NUTAB AS "nutab", T.PERCENTUAL AS "percentual", T.CODTABORIG AS "origem"
    FROM TGFTAB T
    WHERE T.DTVIGOR <= SYSDATE
      AND T.DTVIGOR = (SELECT MAX(M.DTVIGOR) FROM TGFTAB M WHERE M.CODTAB = T.CODTAB AND M.DTVIGOR <= SYSDATE)
  `);
  const porCodtab = new Map(versoes.map((v) => [v.codtab, v]));

  const cache = new Map<number, Map<string, number>>();
  const daTabela = async (codtab: number, visitadas = new Set<number>()): Promise<Map<string, number>> => {
    if (cache.has(codtab)) return cache.get(codtab)!;
    const v = porCodtab.get(codtab);
    const precos = new Map<string, number>();
    if (!v || visitadas.has(codtab)) return precos;
    visitadas.add(codtab);
    const proprias = await paginado<{ p: number; v: number }>((offset) => `
      SELECT CODPROD AS "p", VLRVENDA AS "v" FROM TGFEXC
      WHERE NUTAB = ${Number(v.nutab)} AND VLRVENDA IS NOT NULL
      ORDER BY CODPROD OFFSET ${offset} ROWS FETCH NEXT ${PAGINA} ROWS ONLY
    `);
    for (const linha of proprias) precos.set(String(linha.p), Number(linha.v));
    if (v.origem !== null && v.origem !== undefined) {
      const fator = 1 + (Number(v.percentual) || 0) / 100;
      for (const [p, valor] of await daTabela(Number(v.origem), visitadas)) {
        if (!precos.has(p)) precos.set(p, Math.round(valor * fator * 10000) / 10000);
      }
    }
    cache.set(codtab, precos);
    return precos;
  };

  return {
    balcao: await daTabela(TABELAS.balcao),
    revenda: await daTabela(TABELAS.revenda),
    revenda2: await daTabela(TABELAS.revenda2),
  };
}

export async function getCatalogoProdutos(): Promise<ProdutoConsulta[]> {
  // Sem `<>` no SQL: o gateway engole a consulta (CODPROD > 0 no lugar).
  const produtos = await paginado<{
    codigo: number;
    janauba: string | number | null;
    descricao: string;
    referencia: string | null;
    unidade: string | null;
    barras: string | null;
    lgbi: string | null;
    llapa: string | null;
    llem: string | null;
  }>((offset) => `
    SELECT
      PRO.CODPROD AS "codigo",
      PRO.AD_CODJANAUBA AS "janauba",
      PRO.DESCRPROD AS "descricao",
      PRO.REFERENCIA AS "referencia",
      PRO.CODVOL AS "unidade",
      VOA.CB AS "barras",
      LGBI.DESCRLOCAL AS "lgbi",
      LLAPA.DESCRLOCAL AS "llapa",
      LLEM.DESCRLOCAL AS "llem"
    FROM TGFPRO PRO
    LEFT JOIN (SELECT CODPROD, CODVOL, MIN(CODBARRA) AS CB FROM TGFVOA GROUP BY CODPROD, CODVOL) VOA
      ON VOA.CODPROD = PRO.CODPROD AND VOA.CODVOL = PRO.CODVOL
    LEFT JOIN TGFLOC LGBI ON LGBI.CODLOCAL = PRO.AD_LOCALGBI
    LEFT JOIN TGFLOC LLAPA ON LLAPA.CODLOCAL = PRO.AD_LOCALLAPA
    LEFT JOIN TGFLOC LLEM ON LLEM.CODLOCAL = PRO.AD_LOCALLEM
    WHERE PRO.CODPROD > 0 AND PRO.ATIVO = 'S'
    ORDER BY PRO.CODPROD
    OFFSET ${offset} ROWS FETCH NEXT ${PAGINA} ROWS ONLY
  `);

  const estoques = await paginado<{ p: number; e: number; t: number; r: number }>((offset) => `
    SELECT CODPROD AS "p", CODEMP AS "e", SUM(NVL(ESTOQUE, 0)) AS "t", SUM(NVL(RESERVADO, 0)) AS "r"
    FROM TGFEST
    GROUP BY CODPROD, CODEMP
    ORDER BY CODPROD, CODEMP
    OFFSET ${offset} ROWS FETCH NEXT ${PAGINA} ROWS ONLY
  `);
  const estoquePorProduto = new Map<string, Record<string, { total: number; reservado: number }>>();
  for (const e of estoques) {
    const k = String(e.p);
    const atual = estoquePorProduto.get(k) ?? {};
    atual[String(e.e)] = { total: Number(e.t) || 0, reservado: Number(e.r) || 0 };
    estoquePorProduto.set(k, atual);
  }

  const precos = await precosPorTabela();

  return produtos.map((p) => {
    const codigo = String(p.codigo);
    return {
      codigo,
      codigoJanauba: p.janauba === null || p.janauba === undefined || p.janauba === '' ? null : String(p.janauba),
      descricao: p.descricao,
      referencia: p.referencia ?? null,
      unidade: p.unidade ?? '',
      codigoBarras: p.barras ?? null,
      estoque: estoquePorProduto.get(codigo) ?? {},
      localPadrao: { guanambi: p.lgbi ?? null, lapa: p.llapa ?? null, lem: p.llem ?? null },
      precos: {
        balcao: precos.balcao.get(codigo) ?? null,
        revenda: precos.revenda.get(codigo) ?? null,
        revenda2: precos.revenda2.get(codigo) ?? null,
      },
    };
  });
}

// Estoque e reservado por loja, lidos agora, de poucos produtos: a busca do
// celular usa por cima do catálogo guardado (até 10 min), para a lista bater
// com o detalhe do produto.
export async function getEstoqueAtual(codigos: string[]): Promise<Map<string, ProdutoConsulta['estoque']>> {
  const numeros = [...new Set(codigos.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const porProduto = new Map<string, ProdutoConsulta['estoque']>();
  if (!numeros.length) return porProduto;
  const linhas = await executarQuery<{ p: number; e: number; t: number; r: number }>(`
    SELECT CODPROD AS "p", CODEMP AS "e", SUM(NVL(ESTOQUE, 0)) AS "t", SUM(NVL(RESERVADO, 0)) AS "r"
    FROM TGFEST
    WHERE CODPROD IN (${numeros.join(',')})
    GROUP BY CODPROD, CODEMP
  `);
  for (const n of numeros) porProduto.set(String(n), {});
  for (const l of linhas) porProduto.get(String(l.p))![String(l.e)] = { total: Number(l.t) || 0, reservado: Number(l.r) || 0 };
  return porProduto;
}

export interface DetalheEstoqueProduto {
  locais: { empresaCodigo: string; empresa: string; localCodigo: string; local: string; estoque: number; reservado: number; disponivel: number }[];
  reservas: { numeroUnico: string; numeroNota: string | null; empresaCodigo: string; empresa: string; parceiro: string | null; operacao: string | null; quantidade: number; data: string | null }[];
}

// Os dois quadros de baixo da tela do Sankhya: estoque por loja e local, e
// os pedidos que reservam o produto (só operação que reserva: ATUALEST = 'R').
export async function getDetalheEstoqueProduto(codigoProduto: string): Promise<DetalheEstoqueProduto> {
  const produto = Number(codigoProduto);
  if (!Number.isInteger(produto) || produto <= 0) return { locais: [], reservas: [] };

  const locais = await executarQuery<{ e: number; ne: string | null; l: number; nl: string | null; t: number; r: number }>(`
    SELECT EST.CODEMP AS "e", MAX(EMP.NOMEFANTASIA) AS "ne", EST.CODLOCAL AS "l", MAX(LOC.DESCRLOCAL) AS "nl",
      SUM(NVL(EST.ESTOQUE, 0)) AS "t", SUM(NVL(EST.RESERVADO, 0)) AS "r"
    FROM TGFEST EST
    LEFT JOIN TSIEMP EMP ON EMP.CODEMP = EST.CODEMP
    LEFT JOIN TGFLOC LOC ON LOC.CODLOCAL = EST.CODLOCAL
    WHERE EST.CODPROD = ${produto}
    GROUP BY EST.CODEMP, EST.CODLOCAL
    ORDER BY EST.CODEMP, EST.CODLOCAL
  `);

  const reservas = await executarQuery<{ nu: number; nn: number | null; e: number; ne: string | null; parc: string | null; op: string | null; q: number; d: string | null }>(`
    SELECT
      CAB.NUNOTA AS "nu", CAB.NUMNOTA AS "nn", CAB.CODEMP AS "e", MAX(EMP.NOMEFANTASIA) AS "ne",
      MAX(PAR.NOMEPARC) AS "parc", MAX(TOP.DESCROPER) AS "op",
      NVL(SUM(ITE.QTDNEG - NVL(ITE.QTDENTREGUE, 0)), 0) AS "q",
      TO_CHAR(MAX(CAB.DTNEG), 'YYYY-MM-DD') AS "d"
    FROM TGFITE ITE
    INNER JOIN TGFCAB CAB ON CAB.NUNOTA = ITE.NUNOTA
    INNER JOIN TGFTOP TOP ON TOP.CODTIPOPER = CAB.CODTIPOPER
      AND TOP.DHALTER = (SELECT MAX(T2.DHALTER) FROM TGFTOP T2 WHERE T2.CODTIPOPER = TOP.CODTIPOPER)
    LEFT JOIN TGFPAR PAR ON PAR.CODPARC = CAB.CODPARC
    LEFT JOIN TSIEMP EMP ON EMP.CODEMP = CAB.CODEMP
    WHERE ITE.CODPROD = ${produto}
      AND CAB.PENDENTE = 'S'
      AND TOP.ATUALEST = 'R'
    GROUP BY CAB.NUNOTA, CAB.NUMNOTA, CAB.CODEMP
    HAVING NVL(SUM(ITE.QTDNEG - NVL(ITE.QTDENTREGUE, 0)), 0) > 0
    ORDER BY MAX(CAB.DTNEG) DESC
  `);

  return {
    locais: locais.map((l) => ({
      empresaCodigo: String(l.e),
      empresa: l.ne ?? `Empresa ${l.e}`,
      localCodigo: String(l.l),
      local: l.nl ?? String(l.l),
      estoque: Number(l.t) || 0,
      reservado: Number(l.r) || 0,
      disponivel: Math.round(((Number(l.t) || 0) - (Number(l.r) || 0)) * 1000) / 1000,
    })),
    reservas: reservas.map((r) => ({
      numeroUnico: String(r.nu),
      numeroNota: r.nn === null || r.nn === undefined ? null : String(r.nn),
      empresaCodigo: String(r.e),
      empresa: r.ne ?? `Empresa ${r.e}`,
      parceiro: r.parc ?? null,
      operacao: r.op ?? null,
      quantidade: Number(r.q) || 0,
      data: r.d ?? null,
    })),
  };
}

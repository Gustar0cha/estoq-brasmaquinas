import { executarQuery } from './gateway';
import { FILTRO_SQL_SEM_QUARENTENA } from './client';

// A cópia de estoque do Sankhya (TGFCTE) — a base da contagem livre.
//
// Medido na produção em 01/10/2026: sai uma cópia por dia e por empresa, com
// DTCONTAGEM sempre às 00:00 (as quatro empresas, 22.851 pares produto+local
// na de 01/10). O gestor escolhe qual delas a contagem usa, e é a data dela
// que aparece como "Cópia Estoque Dia 01/10/2026".
//
// DTCONTAGEM é um DATE do Oracle, sem fuso. Ele é tratado como relógio de
// parede: "2026-10-01T00:00:00" vira 2026-10-01T00:00:00Z no Postgres e volta
// igual. Converter pra horário de Brasília aqui deslocaria a cópia de dia.

export interface CopiaEstoqueSankhya {
  // "2026-10-01T00:00:00", exatamente como o Sankhya grava.
  dataCopia: string;
  empresaCodigo: string;
  empresaNome: string;
  locais: number;
  linhas: number;
}

export async function listarCopiasEstoque(diasAtras = 45): Promise<CopiaEstoqueSankhya[]> {
  const linhas = await executarQuery<{
    dataCopia: string;
    empresaCodigo: number;
    empresaNome: string | null;
    locais: number;
    linhas: number;
  }>(`
    SELECT
      TO_CHAR(CTE.DTCONTAGEM, 'YYYY-MM-DD"T"HH24:MI:SS') AS "dataCopia",
      CTE.CODEMP                  AS "empresaCodigo",
      MAX(EMP.NOMEFANTASIA)       AS "empresaNome",
      COUNT(DISTINCT CTE.CODLOCAL) AS "locais",
      COUNT(*)                    AS "linhas"
    FROM TGFCTE CTE
    LEFT JOIN TSIEMP EMP ON EMP.CODEMP = CTE.CODEMP
    WHERE CTE.DTCONTAGEM >= TRUNC(SYSDATE) - ${Math.max(1, Math.floor(diasAtras))}
    GROUP BY CTE.DTCONTAGEM, CTE.CODEMP
    ORDER BY CTE.DTCONTAGEM DESC, CTE.CODEMP
  `);

  return linhas.map((l) => ({
    dataCopia: l.dataCopia,
    empresaCodigo: String(l.empresaCodigo),
    empresaNome: l.empresaNome ?? `Empresa ${l.empresaCodigo}`,
    locais: Number(l.locais),
    linhas: Number(l.linhas),
  }));
}

export interface LinhaRetratoCopia {
  empresaCodigo: string;
  codigoProduto: string;
  descricao: string;
  unidade: string;
  localCodigo: string;
  local: string;
  quantidadeTotal: number;
}

function dataOracle(dataCopia: string): string {
  // Só aceita o formato que o próprio Sankhya devolveu: é texto que vai
  // dentro do SQL.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(dataCopia)) {
    throw new Error('Data da cópia inválida.');
  }
  return `TO_DATE('${dataCopia.replace('T', ' ')}', 'YYYY-MM-DD HH24:MI:SS')`;
}

function listaEmpresas(empresas: string[]): string {
  const numeros = [...new Set(empresas.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (numeros.length === 0) throw new Error('Escolha ao menos uma empresa.');
  return numeros.join(', ');
}

// Todas as linhas da cópia pras empresas escolhidas. Paginado de 5000 em
// 5000 porque é o teto do gateway — passar disso volta truncado, sem erro.
//
// Fica de fora o que está em área de quarentena: produto em quarentena não
// entra em contagem (mesma regra do resto do sistema).
export async function getRetratoCopia(dataCopia: string, empresas: string[]): Promise<LinhaRetratoCopia[]> {
  const data = dataOracle(dataCopia);
  const emp = listaEmpresas(empresas);
  const todas: LinhaRetratoCopia[] = [];

  for (let offset = 0; ; offset += 5000) {
    const pagina = await executarQuery<{
      empresaCodigo: number;
      codigoProduto: number;
      descricao: string;
      unidade: string | null;
      localCodigo: number;
      local: string | null;
      quantidadeTotal: number | null;
    }>(`
      SELECT
        CTE.CODEMP           AS "empresaCodigo",
        CTE.CODPROD          AS "codigoProduto",
        MAX(PRO.DESCRPROD)   AS "descricao",
        MAX(PRO.CODVOL)      AS "unidade",
        CTE.CODLOCAL         AS "localCodigo",
        MAX(COALESCE(LOC.DESCRLOCAL, TO_CHAR(CTE.CODLOCAL))) AS "local",
        -- O mesmo produto+local vem em mais de uma linha quando tem lote.
        SUM(NVL(CTE.QTDEST, 0)) AS "quantidadeTotal"
      FROM TGFCTE CTE
      INNER JOIN TGFPRO PRO ON PRO.CODPROD = CTE.CODPROD
      LEFT JOIN TGFLOC LOC ON LOC.CODLOCAL = CTE.CODLOCAL
      WHERE CTE.DTCONTAGEM = ${data}
        AND CTE.CODEMP IN (${emp})
        AND ${FILTRO_SQL_SEM_QUARENTENA}
      GROUP BY CTE.CODEMP, CTE.CODLOCAL, CTE.CODPROD
      ORDER BY CTE.CODEMP, CTE.CODLOCAL, CTE.CODPROD
      OFFSET ${offset} ROWS FETCH NEXT 5000 ROWS ONLY
    `);

    for (const l of pagina) {
      todas.push({
        empresaCodigo: String(l.empresaCodigo),
        codigoProduto: String(l.codigoProduto),
        descricao: l.descricao,
        unidade: l.unidade ?? '',
        localCodigo: String(l.localCodigo),
        local: l.local ?? String(l.localCodigo),
        quantidadeTotal: Number(l.quantidadeTotal ?? 0),
      });
    }
    if (pagina.length < 5000) break;
  }

  return todas;
}

// Custo médio sem ICMS (TGFCUS.CUSSEMICM) vigente no dia da cópia, pra cada
// produto+empresa DELA. O filtro por produto é um subselect na própria cópia,
// não uma lista de IN: são ~13 mil produtos, e em lotes de 500 seriam 26
// idas ao gateway em vez de três páginas.
export async function getCustosDaCopia(dataCopia: string, empresas: string[]): Promise<Map<string, number>> {
  const data = dataOracle(dataCopia);
  const emp = listaEmpresas(empresas);
  const custos = new Map<string, number>();

  for (let offset = 0; ; offset += 5000) {
    const pagina = await executarQuery<{ codigoProduto: number; empresaCodigo: number; custoSemIcms: number | null }>(`
      SELECT "codigoProduto", "empresaCodigo", "custoSemIcms"
      FROM (
        SELECT
          CUS.CODPROD   AS "codigoProduto",
          CUS.CODEMP    AS "empresaCodigo",
          CUS.CUSSEMICM AS "custoSemIcms",
          ROW_NUMBER() OVER (
            PARTITION BY CUS.CODPROD, CUS.CODEMP ORDER BY CUS.DTATUAL DESC
          ) AS RN
        FROM TGFCUS CUS
        WHERE CUS.CODEMP IN (${emp})
          AND CUS.DTATUAL < ${data} + 1
          AND CUS.CODPROD IN (
            SELECT DISTINCT CTE.CODPROD FROM TGFCTE CTE
            WHERE CTE.DTCONTAGEM = ${data} AND CTE.CODEMP IN (${emp})
          )
      )
      WHERE RN = 1
      ORDER BY "codigoProduto", "empresaCodigo"
      OFFSET ${offset} ROWS FETCH NEXT 5000 ROWS ONLY
    `);

    for (const l of pagina) {
      if (l.custoSemIcms !== null && l.custoSemIcms !== undefined) {
        custos.set(`${l.codigoProduto}|${l.empresaCodigo}`, Number(l.custoSemIcms));
      }
    }
    if (pagina.length < 5000) break;
  }

  return custos;
}

export interface LocalSankhya {
  localCodigo: string;
  local: string;
}

// A etiqueta lida é um local que existe? Usado só quando o local não aparece
// na cópia (prateleira sem saldo nenhum no sistema), pra distinguir "local
// vazio no ERP" de "isso nem é etiqueta de local".
export async function getLocalSankhya(codigo: string): Promise<LocalSankhya | null> {
  if (!/^\d{1,12}$/.test(codigo)) return null;
  const [linha] = await executarQuery<{ localCodigo: number; local: string | null }>(`
    SELECT LOC.CODLOCAL AS "localCodigo", LOC.DESCRLOCAL AS "local"
    FROM TGFLOC LOC
    WHERE LOC.CODLOCAL = ${Number(codigo)}
  `);
  if (!linha) return null;
  return { localCodigo: String(linha.localCodigo), local: linha.local ?? String(linha.localCodigo) };
}

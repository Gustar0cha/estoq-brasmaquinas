import { executarQuery } from './gateway';
import { env } from '../lib/env';
import { FiltroMovimentacoesSankhya, ItemMovimentacaoSankhya, MovimentacaoSankhya } from './types';

// Integração com o Sankhya via API Gateway (OAuth2 + DbExplorerSP.executeQuery)
// — ver src/sankhya/auth.ts e src/sankhya/gateway.ts. A query abaixo é
// adaptada da consulta usada no dashboard de estoque do Sankhya de vocês
// (TGFCAB/TGFITE/TGFPRO/TGFTOP/TGFPAR).
//
// ATENÇÃO — campos abaixo foram adicionados por cima da query original e
// ainda não foram totalmente confirmados; ajuste só a query se algo vier
// errado — o resto do backend não muda:
//   - PAR.NOMEPARC (nome do parceiro/fornecedor/cliente, join com TGFPAR)
//   - PRO.CODVOL (código de unidade do produto — é o CÓDIGO, não a sigla "UN")
// `codigoBarras` não é buscado (TGFPRO.CODBARRA não existe neste ambiente e
// o app não usa mais leitura de código de barras) — fica sempre "".
//
// `local` vem de TGFLOC.DESCRLOCAL (join por ITE.CODLOCALORIG), igual na
// query original de vocês; se não houver local cadastrado, cai pro código.
//
// O serviço DbExplorerSP.executeQuery só aceita uma string de SQL (sem bind
// parameters separados), então os valores abaixo são interpolados com
// cuidado — todos vêm de números já validados (Number.isFinite) ou de datas
// que nós mesmos construímos, nunca de texto vindo direto do usuário.

interface LinhaMovimentacaoSankhya {
  id: number;
  numeroNota: number;
  tipo: 'ENTRADA' | 'SAIDA' | null;
  parceiro: string | null;
  dataMovimentacao: string;
  codigoProduto: number;
  descricao: string;
  unidade: string | null;
  local: string | null;
  quantidadeEsperada: number;
}

function formatarDataOracle(data: Date): string {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `TO_DATE('${ano}-${mes}-${dia}', 'YYYY-MM-DD')`;
}

function montarSelectBase(): string {
  return `
    SELECT
      CAB.NUNOTA           AS "id",
      CAB.NUNOTA           AS "numeroNota",
      CASE
        WHEN CAB.CODTIPOPER = 800 THEN 'SAIDA'
        WHEN TOP.ATUALEST = 'E' THEN 'ENTRADA'
        WHEN TOP.ATUALEST = 'B' THEN 'SAIDA'
      END AS "tipo",
      PAR.NOMEPARC         AS "parceiro",
      TO_CHAR(CAB.DTNEG, 'YYYY-MM-DD"T"HH24:MI:SS') AS "dataMovimentacao",
      ITE.CODPROD          AS "codigoProduto",
      PRO.DESCRPROD        AS "descricao",
      PRO.CODVOL           AS "unidade",
      COALESCE(LOC.DESCRLOCAL, TO_CHAR(ITE.CODLOCALORIG)) AS "local",
      SUM(ITE.QTDNEG)      AS "quantidadeEsperada"
    FROM TGFCAB CAB
    INNER JOIN TGFITE ITE ON CAB.NUNOTA = ITE.NUNOTA
    INNER JOIN TGFPRO PRO ON ITE.CODPROD = PRO.CODPROD
    INNER JOIN TGFTOP TOP ON CAB.CODTIPOPER = TOP.CODTIPOPER AND CAB.DHTIPOPER = TOP.DHALTER
    LEFT JOIN TGFPAR PAR ON CAB.CODPARC = PAR.CODPARC
    LEFT JOIN TGFLOC LOC ON ITE.CODLOCALORIG = LOC.CODLOCAL
  `;
}

const GROUP_BY = `
  GROUP BY
    CAB.NUNOTA, CAB.CODTIPOPER, TOP.ATUALEST, PAR.NOMEPARC, CAB.DTNEG,
    ITE.CODPROD, PRO.DESCRPROD, PRO.CODVOL, ITE.CODLOCALORIG, LOC.DESCRLOCAL
`;

function agruparPorNota(linhas: LinhaMovimentacaoSankhya[]): MovimentacaoSankhya[] {
  const porNota = new Map<string, MovimentacaoSankhya>();

  for (const linha of linhas) {
    // Linhas sem ENTRADA/SAIDA definidas não deveriam ocorrer (o WHERE já
    // filtra só operações que mexem estoque), mas ignoramos defensivamente.
    if (!linha.tipo) continue;

    const id = String(linha.id);
    let movimentacao = porNota.get(id);

    if (!movimentacao) {
      movimentacao = {
        id,
        numeroNota: String(linha.numeroNota),
        tipo: linha.tipo,
        parceiro: linha.parceiro ?? 'Não identificado',
        dataMovimentacao: linha.dataMovimentacao,
        itens: [],
      };
      porNota.set(id, movimentacao);
    }

    const item: ItemMovimentacaoSankhya = {
      id: `${id}-${linha.codigoProduto}`,
      codigoProduto: String(linha.codigoProduto),
      codigoBarras: '',
      descricao: linha.descricao,
      unidade: linha.unidade ?? '',
      local: linha.local ?? '',
      quantidadeEsperada: linha.quantidadeEsperada,
    };
    movimentacao.itens.push(item);
  }

  return Array.from(porNota.values());
}

export async function getMovimentacoesSankhya(
  filtro?: FiltroMovimentacoesSankhya
): Promise<MovimentacaoSankhya[]> {
  const dataFim = new Date();
  const dataInicio = new Date(dataFim);
  dataInicio.setDate(dataInicio.getDate() - env.sankhya.diasHistorico);

  const sql = `
    ${montarSelectBase()}
    WHERE
      CAB.CODEMP = ${env.sankhya.codEmpresa}
      AND CAB.STATUSNOTA = 'L'
      AND (TOP.ATUALEST IN ('B', 'E') OR CAB.CODTIPOPER = 800)
      AND TRUNC(CAB.DTNEG) BETWEEN ${formatarDataOracle(dataInicio)} AND ${formatarDataOracle(dataFim)}
    ${GROUP_BY}
    ORDER BY CAB.DTNEG DESC, CAB.NUNOTA DESC
  `;

  const linhas = await executarQuery<LinhaMovimentacaoSankhya>(sql);
  const movimentacoes = agruparPorNota(linhas);

  if (filtro?.tipo) {
    return movimentacoes.filter((m) => m.tipo === filtro.tipo);
  }
  return movimentacoes;
}

export async function getMovimentacaoSankhyaPorId(id: string): Promise<MovimentacaoSankhya | null> {
  const nunota = Number(id);
  if (!Number.isFinite(nunota)) {
    return null;
  }

  const sql = `
    ${montarSelectBase()}
    WHERE
      CAB.NUNOTA = ${nunota}
      AND CAB.CODEMP = ${env.sankhya.codEmpresa}
      AND CAB.STATUSNOTA = 'L'
    ${GROUP_BY}
    ORDER BY ITE.CODPROD
  `;

  const linhas = await executarQuery<LinhaMovimentacaoSankhya>(sql);
  const [movimentacao] = agruparPorNota(linhas);
  return movimentacao ?? null;
}

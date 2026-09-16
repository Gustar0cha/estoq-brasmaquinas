import { prisma } from '../lib/prisma';
import { chaveCusto, getCustosSemIcms, getGruposDeProduto } from '../sankhya/client';

// Dashboard da contagem, em dois modos.
//
// AO_VIVO responde "como está a contagem agora": inclui o que ainda falta,
// porque o que falta é justamente a informação útil enquanto a operação
// acontece. Uma contagem leva dias, então tudo que é progresso vem também
// quebrado por dia.
//
// HISTORICO responde "como foi a contagem que terminou": só entra o que foi
// efetivamente contado no período, e o foco sai de "quanto falta" para
// acurácia e dinheiro — que é o que interessa a quem decide depois.

export type ModoDashboard = 'AO_VIVO' | 'HISTORICO';

export interface FiltroDashboard {
  modo: ModoDashboard;
  dataInicio?: Date;
  dataFim?: Date;
}

export interface RankingUsuarioDashboard {
  usuarioId: string;
  nome: string;
  contados: number;
  divergencias: number;
  // % dos itens que a pessoa contou e bateram com o sistema.
  acuracia: number;
  pendentes: number;
  valorContado: number;
}

export interface DiaDashboard {
  dia: string; // YYYY-MM-DD
  contados: number;
  divergencias: number;
  valorContado: number;
}

export interface GrupoDashboard {
  grupo: string;
  itens: number;
  divergencias: number;
  valorDivergencia: number;
}

export interface PredioDashboard {
  rua: string | null;
  predio: string | null;
  total: number;
  contados: number;
  pendentes: number;
  divergencias: number;
}

export interface DashboardContagem {
  modo: ModoDashboard;
  periodo: { inicio: string | null; fim: string | null };
  atualizadoEm: string;

  totais: {
    itens: number;
    contados: number;
    pendentes: number;
    emAndamento: number;
    divergencias: number;
    divergenciaLocal: number;
    segundaContagem: number;
    percentualConcluido: number;
    acuracia: number;
    // Quantos itens não têm custo no Sankhya. Sem isso o valor em R$ pareceria
    // completo mesmo quando parte do inventário não entrou na conta.
    itensSemCusto: number;
  };

  valores: {
    contado: number;
    esperado: number;
    divergenciaAbsoluta: number;
    sobra: number;
    falta: number;
    // Itens ainda não contados, avaliados pelo que o sistema diz haver ali.
    aContar: number;
  };

  ranking: RankingUsuarioDashboard[];
  porDia: DiaDashboard[];
  grupos: GrupoDashboard[];
  predios: PredioDashboard[];
  operadoresAtivos: number;
}

const STATUS_CONTADO = ['CONFERIDA', 'DIVERGENCIA', 'DIVERGENCIA_LOCAL'];
const STATUS_DIVERGENTE = ['DIVERGENCIA', 'DIVERGENCIA_LOCAL'];

interface ItemDashboard {
  id: string;
  empresaCodigo: string;
  codigoProduto: string;
  status: string;
  rua: string | null;
  predio: string | null;
  quantidadeEsperada: number;
  quantidadeConferida: number | null;
  quantidadeConferida2: number | null;
  dataConferencia: Date | null;
  dataConferencia2: Date | null;
  atribuidoParaId: string | null;
  conferidoPorId: string | null;
  conferidoPor2Id: string | null;
}

// A quantidade que vale é a da última contagem: se houve recontagem, é ela
// que corrige a primeira.
function quantidadeFinal(item: ItemDashboard): number | null {
  return item.quantidadeConferida2 ?? item.quantidadeConferida;
}

function dataFinal(item: ItemDashboard): Date | null {
  return item.dataConferencia2 ?? item.dataConferencia;
}

function foiContado(item: ItemDashboard): boolean {
  return STATUS_CONTADO.includes(item.status) && quantidadeFinal(item) !== null;
}

function diaDe(data: Date): string {
  return data.toISOString().slice(0, 10);
}

export async function getDashboardContagem(filtro: FiltroDashboard): Promise<DashboardContagem> {
  const where =
    filtro.modo === 'HISTORICO'
      ? {
          status: { in: STATUS_CONTADO },
          // No histórico a data que importa é a da contagem, não a da
          // atribuição: o recorte é "o que foi contado nesse período".
          OR: [
            { dataConferencia: { gte: filtro.dataInicio, lte: filtro.dataFim } },
            { dataConferencia2: { gte: filtro.dataInicio, lte: filtro.dataFim } },
          ],
        }
      : {};

  const itens = (await prisma.contagemItem.findMany({
    where,
    select: {
      id: true,
      empresaCodigo: true,
      codigoProduto: true,
      status: true,
      rua: true,
      predio: true,
      quantidadeEsperada: true,
      quantidadeConferida: true,
      quantidadeConferida2: true,
      dataConferencia: true,
      dataConferencia2: true,
      atribuidoParaId: true,
      conferidoPorId: true,
      conferidoPor2Id: true,
    },
  })) as ItemDashboard[];

  const usuarios = await prisma.usuario.findMany({ select: { id: true, nome: true } });
  const nomePorId = new Map(usuarios.map((u) => [u.id, u.nome]));

  // Custo e grupo vêm do Sankhya em duas consultas em lote, não uma por item.
  const [custos, grupos] = await Promise.all([
    getCustosSemIcms(itens.map((i) => ({ codigoProduto: i.codigoProduto, empresaCodigo: i.empresaCodigo }))),
    getGruposDeProduto(itens.map((i) => i.codigoProduto)),
  ]);

  const custoDe = (item: ItemDashboard) =>
    custos.get(chaveCusto(item.codigoProduto, item.empresaCodigo)) ?? 0;

  const totais = {
    itens: itens.length,
    contados: 0,
    pendentes: 0,
    emAndamento: 0,
    divergencias: 0,
    divergenciaLocal: 0,
    segundaContagem: 0,
    percentualConcluido: 0,
    acuracia: 0,
    itensSemCusto: 0,
  };

  const valores = {
    contado: 0,
    esperado: 0,
    divergenciaAbsoluta: 0,
    sobra: 0,
    falta: 0,
    aContar: 0,
  };

  const porUsuario = new Map<string, RankingUsuarioDashboard>();
  const porDia = new Map<string, DiaDashboard>();
  const porGrupo = new Map<string, GrupoDashboard>();
  const porPredio = new Map<string, PredioDashboard>();

  for (const item of itens) {
    const custo = custoDe(item);
    if (custo === 0) totais.itensSemCusto += 1;
    const contado = foiContado(item);
    const divergente = STATUS_DIVERGENTE.includes(item.status);

    if (item.status === 'PENDENTE') totais.pendentes += 1;
    if (item.status === 'EM_ANDAMENTO') totais.emAndamento += 1;
    if (item.status === 'AGUARDANDO_SEGUNDA_CONTAGEM' || item.status === 'SEGUNDA_EM_ANDAMENTO') {
      totais.segundaContagem += 1;
    }
    if (item.status === 'DIVERGENCIA_LOCAL') totais.divergenciaLocal += 1;
    if (divergente) totais.divergencias += 1;

    valores.esperado += item.quantidadeEsperada * custo;

    if (!contado) {
      valores.aContar += item.quantidadeEsperada * custo;
    } else {
      const quantidade = quantidadeFinal(item) ?? 0;
      const diferenca = quantidade - item.quantidadeEsperada;

      totais.contados += 1;
      valores.contado += quantidade * custo;
      valores.divergenciaAbsoluta += Math.abs(diferenca) * custo;
      if (diferenca > 0) valores.sobra += diferenca * custo;
      if (diferenca < 0) valores.falta += Math.abs(diferenca) * custo;

      // --- por dia ---
      const data = dataFinal(item);
      if (data) {
        const dia = diaDe(data);
        const atual = porDia.get(dia) ?? { dia, contados: 0, divergencias: 0, valorContado: 0 };
        atual.contados += 1;
        atual.valorContado += quantidade * custo;
        if (divergente) atual.divergencias += 1;
        porDia.set(dia, atual);
      }

      // --- por grupo de produto ---
      const grupo = grupos.get(item.codigoProduto) ?? 'Sem grupo';
      const grupoAtual = porGrupo.get(grupo) ?? {
        grupo,
        itens: 0,
        divergencias: 0,
        valorDivergencia: 0,
      };
      grupoAtual.itens += 1;
      if (divergente) {
        grupoAtual.divergencias += 1;
        grupoAtual.valorDivergencia += Math.abs(diferenca) * custo;
      }
      porGrupo.set(grupo, grupoAtual);

      // --- ranking ---
      // Quem contou de fato; se não houver registro, cai em quem estava
      // designado (é o caso das contagens antigas, antes do rastreio).
      const autor = item.conferidoPor2Id ?? item.conferidoPorId ?? item.atribuidoParaId;
      if (autor) {
        const dono = porUsuario.get(autor) ?? {
          usuarioId: autor,
          nome: nomePorId.get(autor) ?? 'Desconhecido',
          contados: 0,
          divergencias: 0,
          acuracia: 0,
          pendentes: 0,
          valorContado: 0,
        };
        dono.contados += 1;
        dono.valorContado += quantidade * custo;
        if (divergente) dono.divergencias += 1;
        porUsuario.set(autor, dono);
      }
    }

    // Pendentes entram no ranking de quem tem o item atribuído — no modo ao
    // vivo isso mostra quem ainda tem trabalho pela frente.
    if (!contado && item.atribuidoParaId) {
      const dono = porUsuario.get(item.atribuidoParaId) ?? {
        usuarioId: item.atribuidoParaId,
        nome: nomePorId.get(item.atribuidoParaId) ?? 'Desconhecido',
        contados: 0,
        divergencias: 0,
        acuracia: 0,
        pendentes: 0,
        valorContado: 0,
      };
      dono.pendentes += 1;
      porUsuario.set(item.atribuidoParaId, dono);
    }

    // --- por prédio ---
    const chavePredio = `${item.rua ?? '?'}|${item.predio ?? '?'}`;
    const predio = porPredio.get(chavePredio) ?? {
      rua: item.rua,
      predio: item.predio,
      total: 0,
      contados: 0,
      pendentes: 0,
      divergencias: 0,
    };
    predio.total += 1;
    if (contado) predio.contados += 1;
    else predio.pendentes += 1;
    if (divergente) predio.divergencias += 1;
    porPredio.set(chavePredio, predio);
  }

  totais.percentualConcluido =
    totais.itens > 0 ? Math.round((totais.contados / totais.itens) * 100) : 0;
  totais.acuracia =
    totais.contados > 0
      ? Math.round(((totais.contados - totais.divergencias) / totais.contados) * 100)
      : 0;

  const ranking = [...porUsuario.values()]
    .map((pessoa) => ({
      ...pessoa,
      acuracia:
        pessoa.contados > 0
          ? Math.round(((pessoa.contados - pessoa.divergencias) / pessoa.contados) * 100)
          : 0,
    }))
    .sort((a, b) => b.contados - a.contados || a.nome.localeCompare(b.nome));

  return {
    modo: filtro.modo,
    periodo: {
      inicio: filtro.dataInicio?.toISOString() ?? null,
      fim: filtro.dataFim?.toISOString() ?? null,
    },
    atualizadoEm: new Date().toISOString(),
    totais,
    valores,
    ranking,
    porDia: [...porDia.values()].sort((a, b) => a.dia.localeCompare(b.dia)),
    grupos: [...porGrupo.values()]
      .filter((g) => g.divergencias > 0)
      .sort((a, b) => b.valorDivergencia - a.valorDivergencia)
      .slice(0, 8),
    predios: [...porPredio.values()].sort((a, b) => b.total - a.total),
    operadoresAtivos: ranking.filter((p) => p.pendentes > 0).length,
  };
}

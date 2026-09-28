import { prisma } from '../lib/prisma';
import { getPrecosDeTabela } from '../sankhya/client';
import { getItensAgrupados } from './itemConferencia.service';

// O tratamento da Mov. Diária pelo gestor.
//
// A divisão de trabalho é essa: o colaborador COLETA — conta às cegas, sem
// ver esperado, conferido nem diferença — e o gestor APURA depois, aqui.
// Preço de tabela e quanto entrou e saiu chegam prontos do Sankhya; o gestor
// corrige o que estiver errado, e só o que ele encostou fica marcado como
// editado. O que não foi editado continua acompanhando o Sankhya, então um
// número corrigido no ERP se reflete sozinho na apuração.

export interface ItemTratamentoDTO {
  chave: string;
  codigoProduto: string;
  descricao: string;
  local: string;
  // O que o colaborador contou. Null = ele não chegou a conferir este item.
  quantidadeConferida: number | null;
  // O saldo do local no Sankhya agora.
  saldoSistema: number;

  // Vindos do Sankhya, corrigíveis pelo gestor.
  precoTabela: number;
  quantidadeEntrada: number;
  quantidadeSaida: number;
  editadoPreco: boolean;
  editadoEntrada: boolean;
  editadoSaida: boolean;

  // Diferença entre o que a pessoa contou e o saldo do sistema, em unidade e
  // em dinheiro pelo preço de tabela. Null quando ninguém contou ainda.
  diferenca: number | null;
  valorDiferenca: number | null;

  comentario: string | null;
  notas: { numeroNota: string; tipo: string; quantidade: number; parceiro: string }[];
}

export interface ResumoTratamentoDTO {
  itens: ItemTratamentoDTO[];
  totalItens: number;
  conferidos: number;
  divergentes: number;
  valorDivergencia: number;
}

export async function getTratamentoDaTarefa(tarefaId: string): Promise<ResumoTratamentoDTO> {
  const itens = await getItensAgrupados({ tarefaId });

  const [precos, tratamentos] = await Promise.all([
    getPrecosDeTabela(itens.map((i) => i.codigoProduto)),
    prisma.tratamentoMovDiaria.findMany({ where: { tarefaId } }),
  ]);
  const porChave = new Map(tratamentos.map((t) => [t.chave, t]));

  const linhas = itens.map((item): ItemTratamentoDTO => {
    const salvo = porChave.get(item.chave);

    // As notas do período já trazem quanto cada uma movimentou; somar por
    // sentido é o que o gestor faria à mão.
    const entradaSankhya = item.notasOrigem
      .filter((n) => n.tipo === 'ENTRADA')
      .reduce((soma, n) => soma + n.quantidade, 0);
    const saidaSankhya = item.notasOrigem
      .filter((n) => n.tipo === 'SAIDA')
      .reduce((soma, n) => soma + n.quantidade, 0);

    const precoTabela =
      salvo?.editadoPreco && salvo.precoTabela !== null
        ? salvo.precoTabela
        : (precos.get(item.codigoProduto) ?? 0);
    const quantidadeEntrada =
      salvo?.editadoEntrada && salvo.quantidadeEntrada !== null
        ? salvo.quantidadeEntrada
        : entradaSankhya;
    const quantidadeSaida =
      salvo?.editadoSaida && salvo.quantidadeSaida !== null ? salvo.quantidadeSaida : saidaSankhya;

    // A diferença é contra o saldo que o sistema dizia NA HORA da contagem —
    // o saldo de agora já pode ter mudado, e comparar com ele faria linhas
    // que não fecham.
    const diferenca = item.diferenca;

    return {
      chave: item.chave,
      codigoProduto: item.codigoProduto,
      descricao: item.descricao,
      local: item.local,
      quantidadeConferida: item.quantidadeConferida,
      saldoSistema: item.quantidadeEsperada,
      precoTabela,
      quantidadeEntrada,
      quantidadeSaida,
      editadoPreco: Boolean(salvo?.editadoPreco),
      editadoEntrada: Boolean(salvo?.editadoEntrada),
      editadoSaida: Boolean(salvo?.editadoSaida),
      diferenca,
      valorDiferenca:
        diferenca === null ? null : Math.round(Math.abs(diferenca) * precoTabela * 100) / 100,
      comentario: salvo?.comentario ?? null,
      notas: item.notasOrigem.map((n) => ({
        numeroNota: n.numeroNota,
        tipo: n.tipo,
        quantidade: n.quantidade,
        parceiro: n.parceiro,
      })),
    };
  });

  return {
    itens: linhas,
    totalItens: linhas.length,
    conferidos: linhas.filter((l) => l.quantidadeConferida !== null).length,
    divergentes: linhas.filter((l) => l.diferenca !== null && l.diferenca !== 0).length,
    valorDivergencia:
      Math.round(
        linhas
          .filter((l) => l.diferenca !== null && l.diferenca !== 0)
          .reduce((soma, l) => soma + (l.valorDiferenca ?? 0), 0) * 100
      ) / 100,
  };
}

export interface SalvarTratamentoInput {
  tarefaId: string;
  chave: string;
  tratadoPorId: string;
  // Ausente = não mexeu neste campo; null = desfazer a edição e voltar ao
  // que o Sankhya diz.
  precoTabela?: number | null;
  quantidadeEntrada?: number | null;
  quantidadeSaida?: number | null;
  comentario?: string | null;
}

export async function salvarTratamento(input: SalvarTratamentoInput): Promise<void> {
  const atual = await prisma.tratamentoMovDiaria.findUnique({
    where: { tarefaId_chave: { tarefaId: input.tarefaId, chave: input.chave } },
  });

  // Passar o campo com um número marca como editado; passar null desfaz a
  // edição — o valor volta a vir do Sankhya na próxima leitura.
  const campo = <T>(recebido: T | null | undefined, salvo: T | null, editado: boolean) => {
    if (recebido === undefined) return { valor: salvo, editado };
    if (recebido === null) return { valor: null, editado: false };
    return { valor: recebido, editado: true };
  };

  const preco = campo(input.precoTabela, atual?.precoTabela ?? null, Boolean(atual?.editadoPreco));
  const entrada = campo(
    input.quantidadeEntrada,
    atual?.quantidadeEntrada ?? null,
    Boolean(atual?.editadoEntrada)
  );
  const saida = campo(
    input.quantidadeSaida,
    atual?.quantidadeSaida ?? null,
    Boolean(atual?.editadoSaida)
  );

  const dados = {
    precoTabela: preco.valor,
    editadoPreco: preco.editado,
    quantidadeEntrada: entrada.valor,
    editadoEntrada: entrada.editado,
    quantidadeSaida: saida.valor,
    editadoSaida: saida.editado,
    comentario: input.comentario === undefined ? (atual?.comentario ?? null) : input.comentario,
    tratadoPorId: input.tratadoPorId,
  };

  await prisma.tratamentoMovDiaria.upsert({
    where: { tarefaId_chave: { tarefaId: input.tarefaId, chave: input.chave } },
    create: { tarefaId: input.tarefaId, chave: input.chave, ...dados },
    update: dados,
  });
}

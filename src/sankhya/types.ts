export type TipoMovimentacaoSankhya = 'ENTRADA' | 'SAIDA';

export interface ItemMovimentacaoSankhya {
  id: string;
  codigoProduto: string;
  codigoBarras: string;
  descricao: string;
  unidade: string;
  // Marca e grupo do Sankhya: é por eles que a Mov. Diária passou a poder ser
  // filtrada, do mesmo jeito que as Atribuições.
  marca: string | null;
  grupoCodigo: string | null;
  grupo: string | null;
  local: string;
  quantidadeEsperada: number;
  // Quanto ESTA nota movimentou do produto neste local. Diferente do saldo:
  // é o que o gestor usa pra explicar a diferença depois da tarefa fechada.
  quantidadeMovimentada: number;
}

export interface MovimentacaoSankhya {
  id: string;
  numeroNota: string;
  tipo: TipoMovimentacaoSankhya;
  parceiro: string;
  dataMovimentacao: string;
  empresaCodigo: string;
  empresaNome: string;
  itens: ItemMovimentacaoSankhya[];
}

export interface FiltroMovimentacoesSankhya {
  tipo?: TipoMovimentacaoSankhya;
  diaReferencia?: import('../lib/datas').DiaReferencia;
}

export type TipoMovimentacaoSankhya = 'ENTRADA' | 'SAIDA';

export interface ItemMovimentacaoSankhya {
  id: string;
  codigoProduto: string;
  codigoBarras: string;
  descricao: string;
  unidade: string;
  local: string;
  quantidadeEsperada: number;
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
}

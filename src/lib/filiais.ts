// Filial (loja) de um local de estoque.
//
// Não existe campo de filial em TGFLOC — a regra da operação é o PREFIXO do
// CODLOCAL: o primeiro dígito do código do local diz a que loja aquela
// prateleira pertence (confirmado com a equipe, 2026-09-11). As etiquetas
// físicas das prateleiras trazem esse mesmo CODLOCAL, então o código bipado
// já identifica a loja sozinho.
//
// Um usuário com `filial` preenchida só enxerga os locais da própria loja;
// `filial` null = vê tudo (o padrão pra admin/matriz).

export type Filial = 'GUANAMBI' | 'LAPA' | 'LUIS_EDUARDO' | 'JANAUBA';

export const FILIAIS: { valor: Filial; label: string; prefixo: string }[] = [
  { valor: 'GUANAMBI', label: 'Guanambi', prefixo: '2' },
  { valor: 'LUIS_EDUARDO', label: 'Luís Eduardo', prefixo: '3' },
  { valor: 'LAPA', label: 'Lapa', prefixo: '5' },
  { valor: 'JANAUBA', label: 'Janaúba', prefixo: '8' },
];

export function ehFilial(valor: string | null | undefined): valor is Filial {
  return FILIAIS.some((f) => f.valor === valor);
}

export function prefixoDaFilial(filial: Filial): string {
  return FILIAIS.find((f) => f.valor === filial)!.prefixo;
}

export function labelFilial(filial: string | null | undefined): string {
  return FILIAIS.find((f) => f.valor === filial)?.label ?? 'Todas as lojas';
}

// Locais cujo primeiro dígito não é de nenhuma loja conhecida retornam null —
// ficam visíveis só pra quem não tem filial definida, nunca são atribuídos
// por engano a uma loja errada.
export function filialDoLocal(localCodigo: string | null | undefined): Filial | null {
  if (!localCodigo) return null;
  const primeiroDigito = localCodigo.trim()[0];
  return FILIAIS.find((f) => f.prefixo === primeiroDigito)?.valor ?? null;
}

// Um local pertence à visão do usuário quando ele não tem filial (vê tudo)
// ou quando o prefixo do local bate com a filial dele.
export function localVisivelPara(localCodigo: string, filialUsuario: string | null | undefined): boolean {
  if (!ehFilial(filialUsuario)) return true;
  return filialDoLocal(localCodigo) === filialUsuario;
}

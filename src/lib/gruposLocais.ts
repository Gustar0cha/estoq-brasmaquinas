import { parsearLocalizacao } from '../sankhya/localizacao';

// Em que grupo cada local aparece no progresso do painel (chamado #576). Os
// endereços novos têm código começando com 2; o resto é endereço antigo, que
// não pode se misturar com a rua nova de mesmo número.

export type TipoGrupoLocal = 'RUA' | 'AREA' | 'ANTIGO';

export interface GrupoLocal {
  id: string;
  titulo: string;
  tipo: TipoGrupoLocal;
  // Número da rua, para ordenar. Área e "outros" vão por nome, depois das ruas.
  rua: number | null;
}

const AREAS: [RegExp, string][] = [
  [/ILHA/, 'Ilhas'],
  [/^\(AUTO\)|AUTO ?ATENDIMENTO/, 'Autoatendimento e loja'],
  [/^CAIXA PRETA/, 'Caixas pretas'],
  [/^V[ÃA]O\b/, 'Vãos entre prédios'],
  [/PROJETO/, 'Projetos'],
  [/PING[ÃA]O/, 'Pingão'],
  [/^SETOR/, 'Setores de fiação, tubulação e mangueiras'],
  [/^OFICINA/, 'Oficinas'],
  [/^[ÁA]REA|RECEBER/, 'Áreas de recebimento, quarentena e externa'],
];

const OUTROS_LOCAIS = 'Outros locais';
const OUTROS_ANTIGOS = 'Outros endereços antigos';

export function grupoDoLocal(localCodigo: string, local: string): GrupoLocal {
  const nome = local.trim().toUpperCase();
  const numeroDaRua = parsearLocalizacao(nome).rua;

  if (!localCodigo.startsWith('2')) {
    return numeroDaRua
      ? { id: `antigo-${Number(numeroDaRua)}`, titulo: `Rua ${Number(numeroDaRua)}`, tipo: 'ANTIGO', rua: Number(numeroDaRua) }
      : { id: 'antigo-outros', titulo: OUTROS_ANTIGOS, tipo: 'ANTIGO', rua: null };
  }
  if (/^RUA\b/.test(nome) && numeroDaRua) {
    return { id: `rua-${Number(numeroDaRua)}`, titulo: `Rua ${Number(numeroDaRua)}`, tipo: 'RUA', rua: Number(numeroDaRua) };
  }
  const area = AREAS.find(([padrao]) => padrao.test(nome))?.[1] ?? OUTROS_LOCAIS;
  return { id: `area-${area}`, titulo: area, tipo: 'AREA', rua: null };
}

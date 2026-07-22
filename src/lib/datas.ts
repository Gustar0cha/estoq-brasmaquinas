// Utilitário de datas específico pra recursos que raciocinam em "dia de
// calendário" (conferência diária): TGFCTE/TGFCAB no Sankhya guardam datas
// sem timezone (o dia que o usuário no Brasil digitou), enquanto o Postgres
// guarda timestamps reais em UTC. Não dá pra confiar em `new Date(string)`
// nem nos getters "locais" (getFullYear/getDate) porque ambos dependem do
// fuso do processo Node — que pode não ser o do Brasil (ex: container em
// UTC). Por isso todo "dia de referência" aqui é tratado explicitamente
// como o dia-calendário em Brasília, nunca como um Date ambíguo.

const HORA_UTC_MEIA_NOITE_BRASIL = 3; // America/Sao_Paulo = UTC-3 (sem horário de verão desde 2019)

export interface DiaReferencia {
  ano: number;
  mes: number; // 1-12
  dia: number;
}

export function parseDiaReferencia(anoMesDia: string): DiaReferencia {
  const [ano, mes, dia] = anoMesDia.split('-').map(Number);
  return { ano, mes, dia };
}

export function formatarDiaReferencia({ ano, mes, dia }: DiaReferencia): string {
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

// Pro dia-calendário de hoje em Brasília, independente do fuso do processo.
export function hojeBrasil(): DiaReferencia {
  const deslocada = new Date(Date.now() - HORA_UTC_MEIA_NOITE_BRASIL * 60 * 60 * 1000);
  return { ano: deslocada.getUTCFullYear(), mes: deslocada.getUTCMonth() + 1, dia: deslocada.getUTCDate() };
}

// Instante exato (UTC) da meia-noite em Brasília do dia informado — usado só
// pra bater com timestamps reais (ex: dataConferencia no Postgres).
export function inicioDoDiaBrasil({ ano, mes, dia }: DiaReferencia): Date {
  return new Date(Date.UTC(ano, mes - 1, dia, HORA_UTC_MEIA_NOITE_BRASIL, 0, 0, 0));
}

export function fimDoDiaBrasil(diaRef: DiaReferencia): Date {
  return new Date(inicioDoDiaBrasil(diaRef).getTime() + 24 * 60 * 60 * 1000 - 1);
}

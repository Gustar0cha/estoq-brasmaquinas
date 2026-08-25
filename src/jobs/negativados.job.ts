import { verificarNovosProdutosNegativados } from '../services/negativados.service';

const INTERVALO_MS = 30 * 60_000; // 30 minutos
const ATRASO_INICIAL_MS = 30_000; // dá tempo do servidor terminar de subir

// Fica de olho nos produtos negativados sozinho, sem o admin precisar
// abrir o relatório — roda dentro do próprio processo Node (mesmo servidor
// Express), sem depender de infra externa de agendamento.
export function iniciarJobNegativados(): void {
  const executar = async () => {
    try {
      const { novos } = await verificarNovosProdutosNegativados();
      if (novos > 0) {
        // eslint-disable-next-line no-console
        console.log(`[negativados] ${novos} produto(s) novo(s) com estoque negativo — notificação criada.`);
      }
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[negativados] falha ao checar produtos negativados:', error);
    }
  };

  setTimeout(() => {
    void executar();
    setInterval(() => void executar(), INTERVALO_MS);
  }, ATRASO_INICIAL_MS);
}

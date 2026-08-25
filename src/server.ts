import { app } from './app';
import { iniciarJobNegativados } from './jobs/negativados.job';
import { env } from './lib/env';

app.listen(env.port, () => {
  // eslint-disable-next-line no-console
  console.log(`estoq-api rodando na porta ${env.port}`);
  iniciarJobNegativados();
});

import 'dotenv/config';

function obrigatoria(nome: string): string {
  const valor = process.env[nome];
  if (!valor) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${nome}`);
  }
  return valor;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: obrigatoria('DATABASE_URL'),
  jwtSecret: obrigatoria('JWT_SECRET'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  sankhya: {
    // API Gateway do Sankhya (OAuth2 client_credentials), lendo os dados via
    // DbExplorerSP.executeQuery — não via banco de dados direto.
    baseUrl:
      process.env.SANKHYA_AMBIENTE === 'sandbox'
        ? 'https://api.sandbox.sankhya.com.br'
        : 'https://api.sankhya.com.br',
    clientId: obrigatoria('SANKHYA_CLIENT_ID'),
    clientSecret: obrigatoria('SANKHYA_CLIENT_SECRET'),
    // Token gerado na tela "Configurações do Gateway" do Sankhya Om.
    xToken: obrigatoria('SANKHYA_X_TOKEN'),
    // Janela de quantos dias pra trás buscar notas — evita puxar o histórico
    // inteiro do Sankhya a cada listagem.
    diasHistorico: Number(process.env.SANKHYA_DIAS_HISTORICO ?? 30),
  },
  minio: {
    endpoint: obrigatoria('MINIO_ENDPOINT'),
    accessKey: obrigatoria('MINIO_ACCESS_KEY'),
    secretKey: obrigatoria('MINIO_SECRET_KEY'),
    bucket: obrigatoria('MINIO_BUCKET'),
    region: process.env.MINIO_REGION ?? 'us-east-1',
  },
};

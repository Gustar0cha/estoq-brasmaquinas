import { Client } from 'minio';

import { env } from './env';

// Bucket privado — nenhuma foto de contagem é servida direto do MinIO pro
// app. Toda leitura passa pela nossa API (autenticada, só admin), que faz
// proxy do stream; o app nunca recebe uma URL do MinIO nem as credenciais.
const url = new URL(env.minio.endpoint);

export const minioClient = new Client({
  endPoint: url.hostname,
  port: url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
  useSSL: url.protocol === 'https:',
  accessKey: env.minio.accessKey,
  secretKey: env.minio.secretKey,
  region: env.minio.region,
});

export const MINIO_BUCKET = env.minio.bucket;

let bucketGarantido: Promise<void> | null = null;

async function garantirBucket(): Promise<void> {
  if (!bucketGarantido) {
    bucketGarantido = (async () => {
      const existe = await minioClient.bucketExists(MINIO_BUCKET).catch(() => false);
      if (!existe) {
        await minioClient.makeBucket(MINIO_BUCKET, env.minio.region);
      }
    })();
  }
  return bucketGarantido;
}

// chave do item vem como "{empresaCodigo}|{codigoProduto}|{localCodigo}" —
// "|" não é ideal em nome de objeto, então normaliza pra "-" só aqui.
function montarObjectKey(chaveItem: string, numeroContagem: number): string {
  const chaveSegura = chaveItem.replace(/\|/g, '-');
  return `contagens/${chaveSegura}/contagem-${numeroContagem}-${Date.now()}.jpg`;
}

export async function uploadFotoContagem(
  chaveItem: string,
  numeroContagem: number,
  buffer: Buffer,
  mimeType: string
): Promise<string> {
  await garantirBucket();
  const objectKey = montarObjectKey(chaveItem, numeroContagem);
  await minioClient.putObject(MINIO_BUCKET, objectKey, buffer, buffer.length, {
    'Content-Type': mimeType,
  });
  return objectKey;
}

export async function obterFotoStream(objectKey: string) {
  return minioClient.getObject(MINIO_BUCKET, objectKey);
}

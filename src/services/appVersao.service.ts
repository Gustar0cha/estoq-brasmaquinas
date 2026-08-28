import { prisma } from '../lib/prisma';
import { minioClient, MINIO_BUCKET } from '../lib/minio';

export interface VersaoDisponivel {
  versionCode: number;
  versionName: string;
  notas: string | null;
  obrigatoria: boolean;
}

export async function getUltimaVersao(): Promise<VersaoDisponivel | null> {
  const versao = await prisma.appVersao.findFirst({ orderBy: { versionCode: 'desc' } });
  if (!versao) return null;

  return {
    versionCode: versao.versionCode,
    versionName: versao.versionName,
    notas: versao.notas,
    obrigatoria: versao.obrigatoria,
  };
}

export interface PublicarVersaoInput {
  versionCode: number;
  versionName: string;
  notas?: string;
  obrigatoria: boolean;
  buffer: Buffer;
}

export async function publicarVersao(input: PublicarVersaoInput): Promise<void> {
  const objectKey = `apks/estoque-${input.versionCode}.apk`;
  await minioClient.putObject(MINIO_BUCKET, objectKey, input.buffer, input.buffer.length, {
    'Content-Type': 'application/vnd.android.package-archive',
  });

  await prisma.appVersao.create({
    data: {
      versionCode: input.versionCode,
      versionName: input.versionName,
      notas: input.notas,
      obrigatoria: input.obrigatoria,
      apkChave: objectKey,
    },
  });
}

export async function getApkStreamUltimaVersao(): Promise<{
  stream: NodeJS.ReadableStream;
  nomeArquivo: string;
} | null> {
  const versao = await prisma.appVersao.findFirst({ orderBy: { versionCode: 'desc' } });
  if (!versao) return null;

  const stream = await minioClient.getObject(MINIO_BUCKET, versao.apkChave);
  return { stream, nomeArquivo: `fluvi-estoque-v${versao.versionCode}.apk` };
}

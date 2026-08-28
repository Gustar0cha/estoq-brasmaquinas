import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { env } from '../lib/env';
import * as appVersaoService from '../services/appVersao.service';

export const appVersaoRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// Pública — o app consulta antes mesmo de logar, então não passa por `autenticar`.
appVersaoRouter.get('/', async (_req, res) => {
  res.json(await appVersaoService.getUltimaVersao());
});

appVersaoRouter.get('/apk', async (_req, res) => {
  const resultado = await appVersaoService.getApkStreamUltimaVersao();
  if (!resultado) {
    res.status(404).json({ erro: 'Nenhuma versão publicada.' });
    return;
  }

  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${resultado.nomeArquivo}"`);
  resultado.stream.pipe(res);
});

const publicarSchema = z.object({
  versionCode: z.coerce.number().int().positive(),
  versionName: z.string().min(1),
  notas: z.string().optional(),
  obrigatoria: z.enum(['true', 'false']).optional(),
});

// Protegida por token estático (não é rota de usuário) — usada só na hora de
// publicar um novo build, via script/curl, não pelo app.
appVersaoRouter.post('/', upload.single('apk'), async (req, res) => {
  const token = req.header('x-publish-token');
  if (!env.appPublishToken || token !== env.appPublishToken) {
    res.status(401).json({ erro: 'Token inválido.' });
    return;
  }

  const parse = publicarSchema.safeParse(req.body);
  if (!parse.success || !req.file) {
    res.status(400).json({ erro: 'Envie o arquivo "apk" e os campos versionCode/versionName.' });
    return;
  }

  await appVersaoService.publicarVersao({
    versionCode: parse.data.versionCode,
    versionName: parse.data.versionName,
    notas: parse.data.notas,
    obrigatoria: parse.data.obrigatoria === 'true',
    buffer: req.file.buffer,
  });

  res.json({ ok: true });
});

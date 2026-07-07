import { Router } from 'express';
import { z } from 'zod';

import { autenticar, exigirAdmin } from '../middleware/auth';
import * as usuariosService from '../services/usuarios.service';

export const usuariosRouter = Router();

usuariosRouter.get('/', autenticar, async (req, res) => {
  if (req.query.role === 'OPERADOR') {
    res.json(await usuariosService.getOperadores());
    return;
  }

  // Listar todos (sem filtro) é restrito ao admin — usado na tela de gestão de usuários.
  if (req.usuario?.role !== 'ADMIN') {
    res.status(403).json({ erro: 'Ação restrita a administradores.' });
    return;
  }
  res.json(await usuariosService.getUsuarios());
});

const criarUsuarioSchema = z.object({
  nome: z.string().min(1),
  login: z.string().min(1),
  senha: z.string().min(4),
  role: z.enum(['ADMIN', 'OPERADOR']),
});

usuariosRouter.post('/', autenticar, exigirAdmin, async (req, res) => {
  const parse = criarUsuarioSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const usuario = await usuariosService.criarUsuario(parse.data);
    res.status(201).json(usuario);
  } catch (error) {
    res.status(409).json({ erro: error instanceof Error ? error.message : 'Não foi possível criar o usuário.' });
  }
});

const atualizarUsuarioSchema = z.object({
  login: z.string().min(1).optional(),
  senha: z.string().min(4).optional(),
  role: z.enum(['ADMIN', 'OPERADOR']).optional(),
});

usuariosRouter.patch('/:id', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  const parse = atualizarUsuarioSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const usuario = await usuariosService.atualizarUsuario(id, parse.data);
    res.json(usuario);
  } catch (error) {
    res
      .status(409)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível atualizar o usuário.' });
  }
});

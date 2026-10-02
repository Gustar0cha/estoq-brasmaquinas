import { registrarLog } from '../lib/logAcao';
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
  filial: z.string().nullable().optional(),
});

usuariosRouter.post('/', autenticar, exigirAdmin, async (req, res) => {
  const parse = criarUsuarioSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ erro: 'Corpo da requisição inválido.', detalhes: parse.error.flatten() });
    return;
  }

  try {
    const usuario = await usuariosService.criarUsuario(parse.data);
    void registrarLog(req.usuario!.sub, 'USUARIO_CRIADO', `Criou o login ${usuario.nome} (${usuario.login}), ${usuario.role === 'ADMIN' ? 'administrador' : 'operador'}.`, { usuarioId: usuario.id });
    res.status(201).json(usuario);
  } catch (error) {
    res.status(409).json({ erro: error instanceof Error ? error.message : 'Não foi possível criar o usuário.' });
  }
});

const atualizarUsuarioSchema = z.object({
  nome: z.string().trim().min(1).optional(),
  login: z.string().min(1).optional(),
  senha: z.string().min(4).optional(),
  role: z.enum(['ADMIN', 'OPERADOR']).optional(),
  filial: z.string().nullable().optional(),
  ativo: z.boolean().optional(),
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
    const mudou = Object.keys(parse.data).map((c) => (c === 'senha' ? 'senha' : c === 'ativo' ? (parse.data.ativo ? 'reativou' : 'desativou') : c));
    void registrarLog(req.usuario!.sub, 'USUARIO_EDITADO', `Editou o login ${usuario.nome}: ${mudou.join(', ')}.`, { usuarioId: id, campos: Object.keys(parse.data) });
    res.json(usuario);
  } catch (error) {
    res
      .status(409)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível atualizar o usuário.' });
  }
});

// Excluir login. Quem já tem histórico não é apagado: é DESATIVADO, senão o
// relatório perderia o nome de quem contou.
usuariosRouter.delete('/:id', autenticar, exigirAdmin, async (req, res) => {
  const { id } = req.params as { id: string };
  if (id === req.usuario!.sub) {
    res.status(400).json({ erro: 'Você não pode excluir o seu próprio login.' });
    return;
  }
  try {
    const alvo = await usuariosService.getUsuarios().then((l) => l.find((u) => u.id === id));
    const resultado = await usuariosService.apagarUsuario(id);
    void registrarLog(req.usuario!.sub, 'USUARIO_EXCLUIDO', `${resultado.apagado ? 'Excluiu' : 'Desativou (tem histórico)'} o login ${alvo?.nome ?? id}.`, { usuarioId: id });
    res.json(resultado);
  } catch (error) {
    res
      .status(400)
      .json({ erro: error instanceof Error ? error.message : 'Não foi possível excluir.' });
  }
});

-- Trava da Consulta de produtos para o contador: o administrador libera
-- por pessoa (Configurações -> Equipe). Só acrescenta: ninguém muda.
ALTER TABLE "usuarios" ADD COLUMN IF NOT EXISTS "consultaProdutos" BOOLEAN NOT NULL DEFAULT false;

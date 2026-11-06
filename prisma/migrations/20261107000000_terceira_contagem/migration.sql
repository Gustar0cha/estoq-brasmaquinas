-- Terceira contagem (chamado #575). Só acrescenta: o que já foi pedido é a 2ª.
ALTER TABLE "contagem_livre_recontagens" ADD COLUMN IF NOT EXISTS "numero" INTEGER NOT NULL DEFAULT 2;

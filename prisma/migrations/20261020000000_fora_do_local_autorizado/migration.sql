-- Quem liberou, com a senha, o registro de produto fora do local.
-- Só acrescenta uma coluna opcional.
ALTER TABLE "contagem_livre_registros" ADD COLUMN "foraDoLocalAutorizadoPor" TEXT;

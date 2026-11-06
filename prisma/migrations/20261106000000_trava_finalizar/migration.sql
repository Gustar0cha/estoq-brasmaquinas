-- Finalizar local com item sem contagem pede o gestor (chamado #574). Só
-- acrescenta: desligada, as contagens que já existem continuam iguais.
ALTER TABLE "contagem_livre" ADD COLUMN IF NOT EXISTS "travaFinalizar" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "contagem_livre_registros" ADD COLUMN IF NOT EXISTS "zeradoPor" TEXT;

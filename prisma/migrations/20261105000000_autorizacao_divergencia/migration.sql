-- Autorização de divergência (chamado #571). Só acrescenta: limite nulo =
-- desligado, então as contagens que já existem continuam iguais.
ALTER TABLE "contagem_livre" ADD COLUMN IF NOT EXISTS "limiteDivergencia" DOUBLE PRECISION;

ALTER TABLE "contagem_livre_registros"
  ADD COLUMN IF NOT EXISTS "aguardandoAutorizacao" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "percentualDivergencia" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "limiteAplicado" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "divergenciaAutorizadaPor" TEXT,
  ADD COLUMN IF NOT EXISTS "divergenciaAutorizadaEm" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "contagem_livre_registros_aguardandoAutorizacao_idx"
  ON "contagem_livre_registros" ("aguardandoAutorizacao");

CREATE TABLE IF NOT EXISTS "contagem_livre_regras_divergencia" (
  "id" TEXT NOT NULL,
  "contagemId" TEXT NOT NULL,
  "tipo" TEXT NOT NULL,
  "valor" TEXT NOT NULL,
  "percentual" DOUBLE PRECISION NOT NULL,
  "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contagem_livre_regras_divergencia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contagem_livre_regras_divergencia_contagemId_fkey" FOREIGN KEY ("contagemId")
    REFERENCES "contagem_livre" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "contagem_livre_regras_divergencia_contagemId_tipo_valor_key"
  ON "contagem_livre_regras_divergencia" ("contagemId", "tipo", "valor");

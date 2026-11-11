-- Justificativa da divergência por produto (chamado #715). Só acrescenta.
CREATE TABLE IF NOT EXISTS "contagem_livre_justificativas" (
  "id" TEXT NOT NULL,
  "contagemId" TEXT NOT NULL,
  "empresaCodigo" TEXT NOT NULL,
  "codigoProduto" TEXT NOT NULL,
  "texto" TEXT NOT NULL,
  "usuarioNome" TEXT NOT NULL,
  "usuarioId" TEXT,
  "atualizadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contagem_livre_justificativas_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contagem_livre_justificativas_contagemId_fkey" FOREIGN KEY ("contagemId")
    REFERENCES "contagem_livre" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "contagem_livre_justificativas_contagemId_codigoProduto_empresaCodigo_key"
  ON "contagem_livre_justificativas" ("contagemId", "codigoProduto", "empresaCodigo");

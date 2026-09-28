CREATE TABLE "projetos" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "projetos_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tarefas" ADD COLUMN "projetoId" TEXT;

CREATE INDEX "tarefas_projetoId_idx" ON "tarefas"("projetoId");

ALTER TABLE "tarefas"
  ADD CONSTRAINT "tarefas_projetoId_fkey"
  FOREIGN KEY ("projetoId") REFERENCES "projetos"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

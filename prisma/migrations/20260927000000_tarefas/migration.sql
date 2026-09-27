-- A tarefa como unidade de trabalho e de recorte dos dados.
--
-- Só ACRESCENTA: pode ser aplicada com a versão antiga no ar, que ignora as
-- tabelas e as colunas novas (todas nulas).

CREATE TABLE "tarefas" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ABERTA',
    "cicloId" TEXT,
    "diaReferencia" TIMESTAMP(3),
    "criadaPorId" TEXT NOT NULL,
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechadaEm" TIMESTAMP(3),
    "observacao" TEXT,
    CONSTRAINT "tarefas_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "tarefa_responsaveis" (
    "id" TEXT NOT NULL,
    "tarefaId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tarefa_responsaveis_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tarefa_responsaveis_tarefaId_usuarioId_key"
  ON "tarefa_responsaveis"("tarefaId", "usuarioId");

ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_cicloId_fkey"
  FOREIGN KEY ("cicloId") REFERENCES "ciclos_contagem"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "tarefas" ADD CONSTRAINT "tarefas_criadaPorId_fkey"
  FOREIGN KEY ("criadaPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tarefa_responsaveis" ADD CONSTRAINT "tarefa_responsaveis_tarefaId_fkey"
  FOREIGN KEY ("tarefaId") REFERENCES "tarefas"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "tarefa_responsaveis" ADD CONSTRAINT "tarefa_responsaveis_usuarioId_fkey"
  FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "contagem_itens" ADD COLUMN "tarefaId" TEXT;
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_tarefaId_fkey"
  FOREIGN KEY ("tarefaId") REFERENCES "tarefas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "item_atribuicoes" ADD COLUMN "tarefaId" TEXT;
ALTER TABLE "item_atribuicoes" ADD CONSTRAINT "item_atribuicoes_tarefaId_fkey"
  FOREIGN KEY ("tarefaId") REFERENCES "tarefas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "item_conferencia_resultados" ADD COLUMN "tarefaId" TEXT;
ALTER TABLE "item_conferencia_resultados" ADD CONSTRAINT "item_conferencia_resultados_tarefaId_fkey"
  FOREIGN KEY ("tarefaId") REFERENCES "tarefas"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "contagem_itens_tarefaId_idx" ON "contagem_itens"("tarefaId");
CREATE INDEX "item_conferencia_resultados_tarefaId_idx" ON "item_conferencia_resultados"("tarefaId");

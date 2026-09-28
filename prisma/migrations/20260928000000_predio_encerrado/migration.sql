-- Um prédio que o colaborador declarou terminado.
--
-- rua/predio são NOT NULL com string vazia para "sem endereço": no Postgres
-- NULL nunca é igual a NULL, então dois encerramentos de uma área sem
-- endereço passariam pela chave única sem se ver.
CREATE TABLE "predios_encerrados" (
    "id" TEXT NOT NULL,
    "tarefaId" TEXT NOT NULL,
    "empresaCodigo" TEXT NOT NULL,
    "rua" TEXT NOT NULL,
    "predio" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "pendentes" INTEGER NOT NULL DEFAULT 0,
    "encerradoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "predios_encerrados_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "predios_encerrados_tarefaId_usuarioId_empresaCodigo_rua_pre_key"
    ON "predios_encerrados"("tarefaId", "usuarioId", "empresaCodigo", "rua", "predio");

ALTER TABLE "predios_encerrados" ADD CONSTRAINT "predios_encerrados_tarefaId_fkey"
    FOREIGN KEY ("tarefaId") REFERENCES "tarefas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "predios_encerrados" ADD CONSTRAINT "predios_encerrados_usuarioId_fkey"
    FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

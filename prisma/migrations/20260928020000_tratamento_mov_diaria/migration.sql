-- O que o gestor apurou num item de Mov. Diária depois que a tarefa fechou.
-- O colaborador só coleta; a explicação (preço, entradas, saídas) mora aqui.
CREATE TABLE "tratamentos_mov_diaria" (
    "id" TEXT NOT NULL,
    "tarefaId" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "precoTabela" DOUBLE PRECISION,
    "quantidadeEntrada" DOUBLE PRECISION,
    "quantidadeSaida" DOUBLE PRECISION,
    "editadoPreco" BOOLEAN NOT NULL DEFAULT false,
    "editadoEntrada" BOOLEAN NOT NULL DEFAULT false,
    "editadoSaida" BOOLEAN NOT NULL DEFAULT false,
    "comentario" TEXT,
    "tratadoPorId" TEXT NOT NULL,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tratamentos_mov_diaria_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tratamentos_mov_diaria_tarefaId_chave_key"
    ON "tratamentos_mov_diaria"("tarefaId", "chave");

ALTER TABLE "tratamentos_mov_diaria" ADD CONSTRAINT "tratamentos_mov_diaria_tarefaId_fkey"
    FOREIGN KEY ("tarefaId") REFERENCES "tarefas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tratamentos_mov_diaria" ADD CONSTRAINT "tratamentos_mov_diaria_tratadoPorId_fkey"
    FOREIGN KEY ("tratadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

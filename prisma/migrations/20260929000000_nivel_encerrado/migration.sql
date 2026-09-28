-- Encerrar passa a ser por NÍVEL, não por prédio.
--
-- Quem encerra é quem está na prateleira, e a prateleira é o nível: medido na
-- produção, nível e código de barras são 1:1 (186 níveis, 186 locais, nenhuma
-- ambiguidade nos dois sentidos). Não existe etiqueta de prédio.
--
-- String vazia, não null: no Postgres NULL nunca é igual a NULL, e a chave
-- única deixaria passar duplicata de "sem nível".
ALTER TABLE "predios_encerrados" ADD COLUMN "nivel" TEXT NOT NULL DEFAULT '';

DROP INDEX IF EXISTS "predios_encerrados_tarefaId_usuarioId_empresaCodigo_rua_pre_key";

CREATE UNIQUE INDEX "predios_encerrados_tarefa_usuario_empresa_rua_predio_nivel_key"
  ON "predios_encerrados" ("tarefaId", "usuarioId", "empresaCodigo", "rua", "predio", "nivel");

-- A tarefa entra na identidade do item de Mov. Diária.
--
-- A chave da conferência é "empresa|produto|local" — sem tarefa e sem data.
-- Com ela única, contar o mesmo produto+local numa tarefa nova SOBRESCREVIA a
-- contagem da tarefa anterior, e a atribuição de hoje roubava o item da
-- tarefa de ontem. São trabalhos distintos sobre o mesmo item, e um não pode
-- se aplicar ao outro.
--
-- Só relaxa restrição: nenhuma linha existente viola o índice novo.

ALTER TABLE "item_solicitacoes_segunda_contagem" ADD COLUMN "tarefaId" TEXT;

DROP INDEX "item_atribuicoes_chave_key";
CREATE UNIQUE INDEX "item_atribuicoes_chave_tarefaId_key"
    ON "item_atribuicoes"("chave", "tarefaId");

DROP INDEX "item_conferencia_resultados_chave_numeroContagem_key";
CREATE UNIQUE INDEX "item_conferencia_resultados_chave_numeroContagem_tarefaId_key"
    ON "item_conferencia_resultados"("chave", "numeroContagem", "tarefaId");

DROP INDEX "item_solicitacoes_segunda_contagem_chave_key";
CREATE UNIQUE INDEX "item_solicitacoes_segunda_contagem_chave_tarefaId_key"
    ON "item_solicitacoes_segunda_contagem"("chave", "tarefaId");

CREATE INDEX "item_atribuicoes_tarefaId_idx" ON "item_atribuicoes"("tarefaId");

-- Nome da tarefa de contagem, dado pelo admin na hora de atribuir.
--
-- Só ACRESCENTA: pode ser aplicada com a versão antiga no ar, que ignora a
-- coluna. Nasce nula nos lotes já atribuídos, e a tela cai no rua/prédio.
ALTER TABLE "contagem_itens" ADD COLUMN "tarefaNome" TEXT;

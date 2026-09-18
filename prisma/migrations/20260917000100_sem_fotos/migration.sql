-- Fim das fotos: o processo passa a ser só bipe.
--
-- APLICAR SÓ DEPOIS de a versão nova estar no ar. A versão antiga lê estas
-- colunas em toda listagem de contagem — derrubá-las antes do deploy quebra
-- o app de todo mundo na hora.
ALTER TABLE "contagem_itens"
DROP COLUMN "fotoChaveArmazenamento",
DROP COLUMN "fotoChaveArmazenamento2";

ALTER TABLE "item_conferencia_resultados" DROP COLUMN "fotoChaveArmazenamento";

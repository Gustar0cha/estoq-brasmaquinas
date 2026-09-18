-- A contagem passa a ser conferida contra o saldo REAL do Sankhya (TGFEST),
-- não mais contra a cópia de estoque diária. Guarda os três números que a
-- operação usa: total, reservado e o esperado (total - reservado).
--
-- Só ACRESCENTA colunas, de propósito: pode ser aplicada com a versão antiga
-- ainda no ar, sem derrubar nada.
ALTER TABLE "contagem_itens"
ADD COLUMN     "dataSaldo" TIMESTAMP(3),
ADD COLUMN     "quantidadeReservada" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "quantidadeTotal" DOUBLE PRECISION;

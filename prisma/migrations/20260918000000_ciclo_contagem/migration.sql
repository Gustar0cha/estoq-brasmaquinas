-- Ciclo de contagem: o recorte que delimita "um inventário".
--
-- Só ACRESCENTA, de propósito: pode ser aplicada com a versão antiga ainda no
-- ar. A coluna cicloId nasce nula e a versão antiga simplesmente a ignora.
CREATE TABLE "ciclos_contagem" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ABERTO',
    "abertoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "abertoPorId" TEXT,
    "fechadoEm" TIMESTAMP(3),
    "fechadoPorId" TEXT,
    "observacao" TEXT,
    CONSTRAINT "ciclos_contagem_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ciclos_contagem" ADD CONSTRAINT "ciclos_contagem_abertoPorId_fkey"
  FOREIGN KEY ("abertoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ciclos_contagem" ADD CONSTRAINT "ciclos_contagem_fechadoPorId_fkey"
  FOREIGN KEY ("fechadoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "contagem_itens" ADD COLUMN "cicloId" TEXT;

ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_cicloId_fkey"
  FOREIGN KEY ("cicloId") REFERENCES "ciclos_contagem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A contagem que já está rodando vira o primeiro ciclo, em vez de ficar órfã.
-- Id fixo pra ser reconhecível e pra reaplicar a migração não duplicar nada.
INSERT INTO "ciclos_contagem" ("id", "nome", "status", "abertoEm", "observacao")
SELECT
  '00000000-0000-4000-8000-000000000001',
  'Contagem de ' || TO_CHAR(MIN("atribuidoEm"), 'MM/YYYY'),
  'ABERTO',
  MIN("atribuidoEm"),
  'Ciclo criado na virada pro controle por inventário; reúne o que já estava em contagem.'
FROM "contagem_itens"
WHERE EXISTS (SELECT 1 FROM "contagem_itens")
ON CONFLICT ("id") DO NOTHING;

UPDATE "contagem_itens"
SET "cicloId" = '00000000-0000-4000-8000-000000000001'
WHERE "cicloId" IS NULL
  AND EXISTS (SELECT 1 FROM "ciclos_contagem" WHERE "id" = '00000000-0000-4000-8000-000000000001');

/*
  Warnings:

  - Added the required column `empresaCodigo` to the `conferencia_resultados` table without a default value. This is not possible if the table is not empty.
  - Added the required column `localCodigo` to the `itens_conferidos` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
-- Colunas criadas como opcionais propositalmente: já existem linhas em
-- produção (6 conferencias / 41 itens). Um script de backfill (ver
-- scripts/backfill-local-empresa.ts) preenche os valores reais consultando
-- o Sankhya, e a migration seguinte trava as colunas como NOT NULL.
ALTER TABLE "conferencia_resultados" ADD COLUMN     "empresaCodigo" TEXT;

-- AlterTable
ALTER TABLE "divergencias" ALTER COLUMN "quantidadeEsperada" SET DATA TYPE DOUBLE PRECISION,
ALTER COLUMN "diferenca" SET DATA TYPE DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "itens_conferidos" ADD COLUMN     "localCodigo" TEXT,
ALTER COLUMN "quantidadeEsperada" SET DATA TYPE DOUBLE PRECISION;

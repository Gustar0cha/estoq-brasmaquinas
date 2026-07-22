/*
  Warnings:

  - Made the column `empresaCodigo` on table `conferencia_resultados` required. This step will fail if there are existing NULL values in that column.
  - Made the column `localCodigo` on table `itens_conferidos` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "conferencia_resultados" ALTER COLUMN "empresaCodigo" SET NOT NULL;

-- AlterTable
ALTER TABLE "itens_conferidos" ALTER COLUMN "localCodigo" SET NOT NULL;

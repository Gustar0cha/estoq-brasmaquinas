-- AlterTable
ALTER TABLE "contagem_itens" ADD COLUMN     "divergenciaLocal" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "localEsperado" TEXT;

-- AlterTable
ALTER TABLE "usuarios" ADD COLUMN     "filial" TEXT;


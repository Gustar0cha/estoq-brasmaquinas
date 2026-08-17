-- DropForeignKey
ALTER TABLE "contagem_estoques" DROP CONSTRAINT "contagem_estoques_iniciadaPorId_fkey";

-- DropForeignKey
ALTER TABLE "contagem_itens" DROP CONSTRAINT "contagem_itens_contagemId_fkey";

-- DropForeignKey
ALTER TABLE "contagem_itens" DROP CONSTRAINT "contagem_itens_usuarioId_fkey";

-- DropIndex
DROP INDEX "contagem_itens_contagemId_codigoProduto_localCodigo_key";

-- AlterTable
ALTER TABLE "contagem_itens" DROP COLUMN "contagemId",
DROP COLUMN "usuarioId",
ADD COLUMN     "iniciadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "iniciadoPorId" TEXT NOT NULL,
ADD COLUMN     "segundaContagemIniciadaEm" TIMESTAMP(3),
ALTER COLUMN "status" SET DEFAULT 'EM_ANDAMENTO';

-- DropTable
DROP TABLE "contagem_estoques";

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_iniciadoPorId_fkey" FOREIGN KEY ("iniciadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


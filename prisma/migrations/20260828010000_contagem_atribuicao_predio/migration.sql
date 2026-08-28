-- DropForeignKey
ALTER TABLE "contagem_itens" DROP CONSTRAINT "contagem_itens_iniciadoPorId_fkey";

-- AlterTable
ALTER TABLE "contagem_itens" ADD COLUMN     "atribuidoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "atribuidoParaId" TEXT,
ADD COLUMN     "atribuidoPorId" TEXT,
ADD COLUMN     "predio" TEXT,
ADD COLUMN     "rua" TEXT,
ALTER COLUMN "status" SET DEFAULT 'PENDENTE',
ALTER COLUMN "iniciadoEm" DROP NOT NULL,
ALTER COLUMN "iniciadoEm" DROP DEFAULT,
ALTER COLUMN "iniciadoPorId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_iniciadoPorId_fkey" FOREIGN KEY ("iniciadoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_atribuidoParaId_fkey" FOREIGN KEY ("atribuidoParaId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_atribuidoPorId_fkey" FOREIGN KEY ("atribuidoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;


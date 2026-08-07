DROP INDEX "item_conferencia_resultados_chave_key";

-- AlterTable
ALTER TABLE "item_conferencia_resultados" ADD COLUMN     "codigoLocalBipado" TEXT,
ADD COLUMN     "codigoProdutoBipado" TEXT,
ADD COLUMN     "fotoChaveArmazenamento" TEXT,
ADD COLUMN     "numeroContagem" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "item_solicitacoes_segunda_contagem" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "solicitadoPorId" TEXT NOT NULL,
    "usuarioId" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "item_solicitacoes_segunda_contagem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notificacoes" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "mensagem" TEXT NOT NULL,
    "lida" BOOLEAN NOT NULL DEFAULT false,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificacoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "item_solicitacoes_segunda_contagem_chave_key" ON "item_solicitacoes_segunda_contagem"("chave");

-- CreateIndex
CREATE UNIQUE INDEX "item_conferencia_resultados_chave_numeroContagem_key" ON "item_conferencia_resultados"("chave", "numeroContagem");

-- AddForeignKey
ALTER TABLE "item_solicitacoes_segunda_contagem" ADD CONSTRAINT "item_solicitacoes_segunda_contagem_solicitadoPorId_fkey" FOREIGN KEY ("solicitadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_solicitacoes_segunda_contagem" ADD CONSTRAINT "item_solicitacoes_segunda_contagem_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;


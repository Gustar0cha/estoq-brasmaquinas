-- AlterTable
ALTER TABLE "notificacoes" ADD COLUMN     "usuarioId" TEXT;

-- CreateTable
CREATE TABLE "notificacao_preferencias" (
    "id" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notificacao_preferencias_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "produtos_negativados_rastreados" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "detectadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "produtos_negativados_rastreados_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "notificacao_preferencias_tipo_usuarioId_key" ON "notificacao_preferencias"("tipo", "usuarioId");

-- CreateIndex
CREATE UNIQUE INDEX "produtos_negativados_rastreados_chave_key" ON "produtos_negativados_rastreados"("chave");

-- AddForeignKey
ALTER TABLE "notificacoes" ADD CONSTRAINT "notificacoes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notificacao_preferencias" ADD CONSTRAINT "notificacao_preferencias_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

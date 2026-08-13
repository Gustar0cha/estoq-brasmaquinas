-- CreateTable
CREATE TABLE "contagem_estoques" (
    "id" TEXT NOT NULL,
    "numero" SERIAL NOT NULL,
    "empresaCodigo" TEXT,
    "empresaNome" TEXT,
    "status" TEXT NOT NULL DEFAULT 'EM_ANDAMENTO',
    "iniciadaPorId" TEXT NOT NULL,
    "iniciadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizadaEm" TIMESTAMP(3),

    CONSTRAINT "contagem_estoques_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contagem_itens" (
    "id" TEXT NOT NULL,
    "contagemId" TEXT NOT NULL,
    "empresaCodigo" TEXT NOT NULL,
    "empresaNome" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "unidade" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "quantidadeEsperada" DOUBLE PRECISION NOT NULL,
    "dataCopiaEstoque" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'PENDENTE',
    "usuarioId" TEXT,
    "quantidadeConferida" INTEGER,
    "diferenca" DOUBLE PRECISION,
    "motivo" TEXT,
    "observacao" TEXT,
    "comentarioAdmin" TEXT,
    "dataConferencia" TIMESTAMP(3),
    "conferidoPorId" TEXT,
    "codigoLocalBipado" TEXT,
    "codigoProdutoBipado" TEXT,
    "fotoChaveArmazenamento" TEXT,
    "segundaContagemSolicitada" BOOLEAN NOT NULL DEFAULT false,
    "segundaContagemSolicitadaPorId" TEXT,
    "segundaContagemUsuarioId" TEXT,
    "quantidadeConferida2" INTEGER,
    "diferenca2" DOUBLE PRECISION,
    "motivo2" TEXT,
    "observacao2" TEXT,
    "dataConferencia2" TIMESTAMP(3),
    "conferidoPor2Id" TEXT,
    "codigoLocalBipado2" TEXT,
    "codigoProdutoBipado2" TEXT,
    "fotoChaveArmazenamento2" TEXT,

    CONSTRAINT "contagem_itens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "contagem_itens_contagemId_codigoProduto_localCodigo_key" ON "contagem_itens"("contagemId", "codigoProduto", "localCodigo");

-- AddForeignKey
ALTER TABLE "contagem_estoques" ADD CONSTRAINT "contagem_estoques_iniciadaPorId_fkey" FOREIGN KEY ("iniciadaPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_contagemId_fkey" FOREIGN KEY ("contagemId") REFERENCES "contagem_estoques"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_conferidoPorId_fkey" FOREIGN KEY ("conferidoPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_segundaContagemSolicitadaPorId_fkey" FOREIGN KEY ("segundaContagemSolicitadaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_segundaContagemUsuarioId_fkey" FOREIGN KEY ("segundaContagemUsuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_itens" ADD CONSTRAINT "contagem_itens_conferidoPor2Id_fkey" FOREIGN KEY ("conferidoPor2Id") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;


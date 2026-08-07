-- CreateTable
CREATE TABLE "item_atribuicoes" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "empresaCodigo" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "usuarioId" TEXT,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "item_atribuicoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_conferencia_resultados" (
    "id" TEXT NOT NULL,
    "chave" TEXT NOT NULL,
    "empresaCodigo" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "quantidadeEsperada" DOUBLE PRECISION NOT NULL,
    "quantidadeConferida" INTEGER NOT NULL,
    "diferenca" DOUBLE PRECISION NOT NULL,
    "conferidoPorId" TEXT NOT NULL,
    "dataConferencia" TIMESTAMP(3) NOT NULL,
    "motivo" TEXT,
    "observacao" TEXT,
    "comentarioAdmin" TEXT,

    CONSTRAINT "item_conferencia_resultados_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "item_atribuicoes_chave_key" ON "item_atribuicoes"("chave");

-- CreateIndex
CREATE UNIQUE INDEX "item_conferencia_resultados_chave_key" ON "item_conferencia_resultados"("chave");

-- AddForeignKey
ALTER TABLE "item_atribuicoes" ADD CONSTRAINT "item_atribuicoes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_conferencia_resultados" ADD CONSTRAINT "item_conferencia_resultados_conferidoPorId_fkey" FOREIGN KEY ("conferidoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

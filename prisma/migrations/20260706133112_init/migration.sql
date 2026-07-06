-- CreateEnum
CREATE TYPE "PapelUsuario" AS ENUM ('ADMIN', 'OPERADOR');

-- CreateTable
CREATE TABLE "usuarios" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "senhaHash" TEXT NOT NULL,
    "role" "PapelUsuario" NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usuarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movimentacao_atribuicoes" (
    "id" TEXT NOT NULL,
    "movimentacaoSankhyaId" TEXT NOT NULL,
    "usuarioId" TEXT,
    "atualizadoEm" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "movimentacao_atribuicoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conferencia_resultados" (
    "id" TEXT NOT NULL,
    "movimentacaoSankhyaId" TEXT NOT NULL,
    "numeroNota" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "parceiro" TEXT NOT NULL,
    "conferidoPorId" TEXT NOT NULL,
    "dataConferencia" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conferencia_resultados_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "itens_conferidos" (
    "id" TEXT NOT NULL,
    "conferenciaId" TEXT NOT NULL,
    "itemSankhyaId" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "quantidadeEsperada" INTEGER NOT NULL,
    "quantidadeConferida" INTEGER,

    CONSTRAINT "itens_conferidos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "divergencias" (
    "id" TEXT NOT NULL,
    "conferenciaId" TEXT NOT NULL,
    "itemSankhyaId" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "quantidadeEsperada" INTEGER NOT NULL,
    "quantidadeConferida" INTEGER NOT NULL,
    "diferenca" INTEGER NOT NULL,
    "motivo" TEXT NOT NULL,
    "observacao" TEXT,
    "comentarioAdmin" TEXT,

    CONSTRAINT "divergencias_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "usuarios_login_key" ON "usuarios"("login");

-- CreateIndex
CREATE UNIQUE INDEX "movimentacao_atribuicoes_movimentacaoSankhyaId_key" ON "movimentacao_atribuicoes"("movimentacaoSankhyaId");

-- CreateIndex
CREATE UNIQUE INDEX "conferencia_resultados_movimentacaoSankhyaId_key" ON "conferencia_resultados"("movimentacaoSankhyaId");

-- AddForeignKey
ALTER TABLE "movimentacao_atribuicoes" ADD CONSTRAINT "movimentacao_atribuicoes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conferencia_resultados" ADD CONSTRAINT "conferencia_resultados_conferidoPorId_fkey" FOREIGN KEY ("conferidoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "itens_conferidos" ADD CONSTRAINT "itens_conferidos_conferenciaId_fkey" FOREIGN KEY ("conferenciaId") REFERENCES "conferencia_resultados"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "divergencias" ADD CONSTRAINT "divergencias_conferenciaId_fkey" FOREIGN KEY ("conferenciaId") REFERENCES "conferencia_resultados"("id") ON DELETE CASCADE ON UPDATE CASCADE;

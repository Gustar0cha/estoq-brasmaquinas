-- Validar locais: a pessoa bipa um local e os produtos dele; o sistema diz
-- se cada um tem saldo ali (TGFEST). Só acrescenta tabelas.
-- CreateEnum
CREATE TYPE "SituacaoValidacao" AS ENUM ('NO_LOCAL', 'FORA_DO_LOCAL', 'SEM_SALDO');

-- CreateTable
CREATE TABLE "validacao_locais" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "empresaCodigo" TEXT,
    "iniciadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizadaEm" TIMESTAMP(3),

    CONSTRAINT "validacao_locais_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "validacao_locais_itens" (
    "id" TEXT NOT NULL,
    "validacaoId" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "unidade" TEXT NOT NULL,
    "codigoBipado" TEXT,
    "situacao" "SituacaoValidacao" NOT NULL,
    "locaisComSaldo" TEXT,
    "bipadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "validacao_locais_itens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "validacao_locais_usuarioId_finalizadaEm_idx" ON "validacao_locais"("usuarioId", "finalizadaEm");

-- CreateIndex
CREATE INDEX "validacao_locais_iniciadaEm_idx" ON "validacao_locais"("iniciadaEm");

-- CreateIndex
CREATE UNIQUE INDEX "validacao_locais_itens_validacaoId_codigoProduto_key" ON "validacao_locais_itens"("validacaoId", "codigoProduto");

-- AddForeignKey
ALTER TABLE "validacao_locais" ADD CONSTRAINT "validacao_locais_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "validacao_locais_itens" ADD CONSTRAINT "validacao_locais_itens_validacaoId_fkey" FOREIGN KEY ("validacaoId") REFERENCES "validacao_locais"("id") ON DELETE CASCADE ON UPDATE CASCADE;


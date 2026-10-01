-- Contagem livre (01/10/2026): cópia de estoque do Sankhya, sessões por local,
-- registros e recontagem. Só cria tabelas novas.
--
-- Gerado por `prisma migrate diff` contra a produção e LIMPO à mão: o diff
-- também propunha apagar contagem_itens_tarefaId_idx e
-- item_conferencia_resultados_tarefaId_idx (índices que existem no banco e
-- seguram as consultas por tarefa) e renomear o índice de predios_encerrados.
-- Nada disso é desta mudança, e apagar os índices deixaria o painel lento.

-- CreateTable
CREATE TABLE "contagem_livre" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "dataCopia" TIMESTAMP(3) NOT NULL,
    "empresas" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'PREPARANDO',
    "erro" TEXT,
    "fotoObrigatoria" BOOLEAN NOT NULL DEFAULT true,
    "travaLocal" BOOLEAN NOT NULL DEFAULT true,
    "travaDuplicada" BOOLEAN NOT NULL DEFAULT true,
    "criadaPorId" TEXT NOT NULL,
    "criadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "encerradaEm" TIMESTAMP(3),

    CONSTRAINT "contagem_livre_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contagem_livre_estoque" (
    "id" TEXT NOT NULL,
    "contagemId" TEXT NOT NULL,
    "empresaCodigo" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "unidade" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "quantidadeTotal" DOUBLE PRECISION NOT NULL,
    "quantidadeReservada" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "custoSemIcms" DOUBLE PRECISION,

    CONSTRAINT "contagem_livre_estoque_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contagem_livre_sessoes" (
    "id" TEXT NOT NULL,
    "contagemId" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "empresaCodigo" TEXT,
    "numeroContagem" INTEGER NOT NULL DEFAULT 1,
    "usuarioId" TEXT NOT NULL,
    "iniciadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizadaEm" TIMESTAMP(3),

    CONSTRAINT "contagem_livre_sessoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contagem_livre_registros" (
    "id" TEXT NOT NULL,
    "contagemId" TEXT NOT NULL,
    "sessaoId" TEXT NOT NULL,
    "numeroContagem" INTEGER NOT NULL DEFAULT 1,
    "empresaCodigo" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "unidade" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "quantidade" DOUBLE PRECISION NOT NULL,
    "foraDoLocal" BOOLEAN NOT NULL DEFAULT false,
    "codigoBipado" TEXT,
    "usuarioId" TEXT NOT NULL,
    "iniciadoEm" TIMESTAMP(3) NOT NULL,
    "registradoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fotoChave" TEXT,
    "chaveUnica" TEXT,

    CONSTRAINT "contagem_livre_registros_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contagem_livre_recontagens" (
    "id" TEXT NOT NULL,
    "contagemId" TEXT NOT NULL,
    "empresaCodigo" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "unidade" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "solicitadaPorId" TEXT NOT NULL,
    "solicitadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atribuidaParaId" TEXT,
    "concluidaEm" TIMESTAMP(3),

    CONSTRAINT "contagem_livre_recontagens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contagem_livre_status_idx" ON "contagem_livre"("status");

-- CreateIndex
CREATE INDEX "contagem_livre_estoque_contagemId_localCodigo_idx" ON "contagem_livre_estoque"("contagemId", "localCodigo");

-- CreateIndex
CREATE INDEX "contagem_livre_estoque_contagemId_codigoProduto_idx" ON "contagem_livre_estoque"("contagemId", "codigoProduto");

-- CreateIndex
CREATE UNIQUE INDEX "contagem_livre_estoque_contagemId_codigoProduto_localCodigo_key" ON "contagem_livre_estoque"("contagemId", "codigoProduto", "localCodigo", "empresaCodigo");

-- CreateIndex
CREATE INDEX "contagem_livre_sessoes_contagemId_localCodigo_idx" ON "contagem_livre_sessoes"("contagemId", "localCodigo");

-- CreateIndex
CREATE INDEX "contagem_livre_sessoes_usuarioId_finalizadaEm_idx" ON "contagem_livre_sessoes"("usuarioId", "finalizadaEm");

-- CreateIndex
CREATE UNIQUE INDEX "contagem_livre_registros_chaveUnica_key" ON "contagem_livre_registros"("chaveUnica");

-- CreateIndex
CREATE INDEX "contagem_livre_registros_contagemId_codigoProduto_localCodi_idx" ON "contagem_livre_registros"("contagemId", "codigoProduto", "localCodigo");

-- CreateIndex
CREATE INDEX "contagem_livre_registros_sessaoId_idx" ON "contagem_livre_registros"("sessaoId");

-- CreateIndex
CREATE INDEX "contagem_livre_registros_contagemId_usuarioId_idx" ON "contagem_livre_registros"("contagemId", "usuarioId");

-- CreateIndex
CREATE INDEX "contagem_livre_recontagens_contagemId_localCodigo_idx" ON "contagem_livre_recontagens"("contagemId", "localCodigo");

-- CreateIndex
CREATE UNIQUE INDEX "contagem_livre_recontagens_contagemId_codigoProduto_localCo_key" ON "contagem_livre_recontagens"("contagemId", "codigoProduto", "localCodigo", "empresaCodigo");

-- AddForeignKey
ALTER TABLE "contagem_livre" ADD CONSTRAINT "contagem_livre_criadaPorId_fkey" FOREIGN KEY ("criadaPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_estoque" ADD CONSTRAINT "contagem_livre_estoque_contagemId_fkey" FOREIGN KEY ("contagemId") REFERENCES "contagem_livre"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_sessoes" ADD CONSTRAINT "contagem_livre_sessoes_contagemId_fkey" FOREIGN KEY ("contagemId") REFERENCES "contagem_livre"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_sessoes" ADD CONSTRAINT "contagem_livre_sessoes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_registros" ADD CONSTRAINT "contagem_livre_registros_contagemId_fkey" FOREIGN KEY ("contagemId") REFERENCES "contagem_livre"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_registros" ADD CONSTRAINT "contagem_livre_registros_sessaoId_fkey" FOREIGN KEY ("sessaoId") REFERENCES "contagem_livre_sessoes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_registros" ADD CONSTRAINT "contagem_livre_registros_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_recontagens" ADD CONSTRAINT "contagem_livre_recontagens_contagemId_fkey" FOREIGN KEY ("contagemId") REFERENCES "contagem_livre"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_recontagens" ADD CONSTRAINT "contagem_livre_recontagens_solicitadaPorId_fkey" FOREIGN KEY ("solicitadaPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_recontagens" ADD CONSTRAINT "contagem_livre_recontagens_atribuidaParaId_fkey" FOREIGN KEY ("atribuidaParaId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Logs de ações, locais ignorados, dono do item (anti-duplicidade) e
-- quarentena da contagem livre. Só cria tabelas novas.
--
-- Gerado por `prisma migrate diff` contra a produção e limpo à mão: ficam de
-- fora os DROP INDEX de contagem_itens_tarefaId_idx e
-- item_conferencia_resultados_tarefaId_idx e o RENAME em predios_encerrados,
-- que são deriva antiga do banco e não fazem parte desta mudança.

-- CreateTable
CREATE TABLE "contagem_livre_item_donos" (
    "chave" TEXT NOT NULL,
    "contagemId" TEXT NOT NULL,
    "usuarioId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contagem_livre_item_donos_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "contagem_livre_quarentenas" (
    "id" TEXT NOT NULL,
    "contagemId" TEXT,
    "contagemNome" TEXT NOT NULL,
    "empresaCodigo" TEXT NOT NULL,
    "codigoProduto" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "unidade" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "quantidadeContada" DOUBLE PRECISION NOT NULL,
    "quantidadeDisponivel" DOUBLE PRECISION NOT NULL,
    "quantidadeDivergente" DOUBLE PRECISION NOT NULL,
    "custoUnitario" DOUBLE PRECISION,
    "observacao" TEXT,
    "usuarioId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contagem_livre_quarentenas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "locais_ignorados" (
    "localCodigo" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "motivo" TEXT,
    "criadoPorId" TEXT NOT NULL,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "locais_ignorados_pkey" PRIMARY KEY ("localCodigo")
);

-- CreateTable
CREATE TABLE "logs_acoes" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT,
    "usuarioNome" TEXT NOT NULL,
    "acao" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "detalhes" JSONB,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "logs_acoes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "contagem_livre_item_donos_contagemId_idx" ON "contagem_livre_item_donos"("contagemId");

-- CreateIndex
CREATE INDEX "contagem_livre_quarentenas_criadoEm_idx" ON "contagem_livre_quarentenas"("criadoEm");

-- CreateIndex
CREATE UNIQUE INDEX "contagem_livre_quarentenas_contagemId_codigoProduto_localCo_key" ON "contagem_livre_quarentenas"("contagemId", "codigoProduto", "localCodigo", "empresaCodigo");

-- CreateIndex
CREATE INDEX "logs_acoes_criadoEm_idx" ON "logs_acoes"("criadoEm");

-- CreateIndex
CREATE INDEX "logs_acoes_acao_idx" ON "logs_acoes"("acao");

-- CreateIndex
CREATE INDEX "logs_acoes_usuarioId_idx" ON "logs_acoes"("usuarioId");

-- AddForeignKey
ALTER TABLE "contagem_livre_item_donos" ADD CONSTRAINT "contagem_livre_item_donos_contagemId_fkey" FOREIGN KEY ("contagemId") REFERENCES "contagem_livre"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_quarentenas" ADD CONSTRAINT "contagem_livre_quarentenas_contagemId_fkey" FOREIGN KEY ("contagemId") REFERENCES "contagem_livre"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contagem_livre_quarentenas" ADD CONSTRAINT "contagem_livre_quarentenas_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "locais_ignorados" ADD CONSTRAINT "locais_ignorados_criadoPorId_fkey" FOREIGN KEY ("criadoPorId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "logs_acoes" ADD CONSTRAINT "logs_acoes_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

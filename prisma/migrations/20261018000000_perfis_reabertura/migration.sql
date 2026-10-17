-- Níveis de acesso e reabertura de local com autorização (chamado #303).
-- Só acrescenta: nenhum dado existente muda.
ALTER TYPE "PapelUsuario" ADD VALUE IF NOT EXISTS 'GESTOR';
ALTER TYPE "PapelUsuario" ADD VALUE IF NOT EXISTS 'VISUALIZADOR';

CREATE TYPE "StatusReabertura" AS ENUM ('PENDENTE', 'AUTORIZADA', 'RECUSADA', 'USADA');

CREATE TABLE "contagem_livre_reaberturas" (
    "id" TEXT NOT NULL,
    "contagemId" TEXT NOT NULL,
    "localCodigo" TEXT NOT NULL,
    "local" TEXT NOT NULL,
    "status" "StatusReabertura" NOT NULL DEFAULT 'PENDENTE',
    "solicitanteId" TEXT NOT NULL,
    "solicitadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizadoPor" TEXT NOT NULL,
    "finalizadoEm" TIMESTAMP(3) NOT NULL,
    "motivo" TEXT,
    "decididaPorId" TEXT,
    "decididaEm" TIMESTAMP(3),
    "usadaEm" TIMESTAMP(3),
    "sessaoId" TEXT,
    CONSTRAINT "contagem_livre_reaberturas_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "contagem_livre_reaberturas_contagemId_localCodigo_solicitan_idx" ON "contagem_livre_reaberturas"("contagemId", "localCodigo", "solicitanteId");
CREATE INDEX "contagem_livre_reaberturas_status_idx" ON "contagem_livre_reaberturas"("status");

ALTER TABLE "contagem_livre_reaberturas" ADD CONSTRAINT "contagem_livre_reaberturas_contagemId_fkey" FOREIGN KEY ("contagemId") REFERENCES "contagem_livre"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "contagem_livre_reaberturas" ADD CONSTRAINT "contagem_livre_reaberturas_solicitanteId_fkey" FOREIGN KEY ("solicitanteId") REFERENCES "usuarios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "contagem_livre_reaberturas" ADD CONSTRAINT "contagem_livre_reaberturas_decididaPorId_fkey" FOREIGN KEY ("decididaPorId") REFERENCES "usuarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

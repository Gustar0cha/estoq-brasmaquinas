-- SKUs esperados no local na validação (chamado #355). Só acrescenta uma coluna opcional.
ALTER TABLE "validacao_locais" ADD COLUMN "esperados" JSONB;

-- Desativar login em vez de apagar: quem já contou não pode sumir sem levar
-- o histórico junto. Só acrescenta, aplicável com a versão antiga no ar.
ALTER TABLE "usuarios" ADD COLUMN "ativo" BOOLEAN NOT NULL DEFAULT true;

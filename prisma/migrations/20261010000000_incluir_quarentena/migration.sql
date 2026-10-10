-- Configuração por contagem: a área de quarentena entra ou não na contagem.
-- Só acrescenta uma coluna com padrão false: o servidor que já está no ar
-- ignora a coluna, então esta migração pode (e deve) ser aplicada ANTES do
-- deploy do código que a usa.
ALTER TABLE "contagem_livre" ADD COLUMN "incluirQuarentena" BOOLEAN NOT NULL DEFAULT false;

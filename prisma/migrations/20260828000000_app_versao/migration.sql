-- CreateTable
CREATE TABLE "app_versoes" (
    "id" TEXT NOT NULL,
    "versionCode" INTEGER NOT NULL,
    "versionName" TEXT NOT NULL,
    "apkChave" TEXT NOT NULL,
    "notas" TEXT,
    "obrigatoria" BOOLEAN NOT NULL DEFAULT false,
    "publicadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_versoes_pkey" PRIMARY KEY ("id")
);

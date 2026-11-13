-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "attachmentBytes" INTEGER,
ADD COLUMN     "attachmentKey" TEXT,
ADD COLUMN     "attachmentName" TEXT,
ADD COLUMN     "attachmentType" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "messages_attachmentKey_key" ON "messages"("attachmentKey");

-- CHECK (no lo modela Prisma): con adjunto el cuerpo recortado puede estar
-- vacío (0 a 2000 caracteres); sin adjunto sigue siendo de 1 a 2000. Sustituye
-- a la versión de `mensajeria_base`, que exigía siempre al menos 1.
ALTER TABLE "messages" DROP CONSTRAINT "messages_cuerpo_longitud";
ALTER TABLE "messages" ADD CONSTRAINT "messages_cuerpo_longitud"
    CHECK (
        char_length(btrim("body"))
            BETWEEN (CASE WHEN "attachmentKey" IS NULL THEN 1 ELSE 0 END) AND 2000
    );

-- CHECK (no lo modela Prisma): las cuatro columnas del adjunto van juntas o
-- ninguna. Que la conversación no sea `PROFILE` lo valida el caso de uso.
ALTER TABLE "messages" ADD CONSTRAINT "messages_adjunto_completo"
    CHECK (
        ("attachmentKey" IS NULL AND "attachmentName" IS NULL
            AND "attachmentType" IS NULL AND "attachmentBytes" IS NULL)
        OR ("attachmentKey" IS NOT NULL AND "attachmentName" IS NOT NULL
            AND "attachmentType" IS NOT NULL AND "attachmentBytes" IS NOT NULL)
    );

-- CHECK (no lo modela Prisma): un adjunto pesa al menos 1 byte. El tope de
-- 10 MiB y los tipos admitidos los valida el caso de uso.
ALTER TABLE "messages" ADD CONSTRAINT "messages_adjunto_bytes"
    CHECK ("attachmentBytes" IS NULL OR "attachmentBytes" > 0);

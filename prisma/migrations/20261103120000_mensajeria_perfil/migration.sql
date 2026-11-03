
-- CreateEnum
CREATE TYPE "ContactRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "declinedAt" TIMESTAMP(3),
ADD COLUMN     "requestStatus" "ContactRequestStatus",
ADD COLUMN     "requesterId" UUID,
ADD COLUMN     "vendorProfileId" UUID;

-- CreateIndex
CREATE INDEX "conversations_requesterId_idx" ON "conversations"("requesterId");

-- CreateIndex
CREATE INDEX "conversations_vendorProfileId_idx" ON "conversations"("vendorProfileId");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_vendorProfileId_fkey" FOREIGN KEY ("vendorProfileId") REFERENCES "vendor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;



-- CHECK (no los modela Prisma). Una conversación PROFILE es la única con
-- solicitante, ficha y estado, y ninguna otra los lleva ni tiene evento.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_perfil_campos"
  CHECK (("kind" = 'PROFILE') = ("eventId" IS NULL AND "requesterId" IS NOT NULL
    AND "vendorProfileId" IS NOT NULL AND "requestStatus" IS NOT NULL));

-- `declinedAt` existe exactamente cuando la solicitud está rechazada. Con
-- `requestStatus` NULL la comparación da NULL, de ahí el COALESCE: ambos lados
-- deben ser false, no NULL (un CHECK con NULL pasa).
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_perfil_rechazo"
  CHECK (("declinedAt" IS NOT NULL) = COALESCE("requestStatus" = 'DECLINED', false));

-- La clave de par de un PROFILE existe y empieza por `profile:` (ver
-- `claveDePerfil`). El IS NOT NULL es necesario: con `pairKey` NULL el LIKE da
-- NULL, el CHECK pasa y la fila esquivaría el UNIQUE de `pairKey`.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_perfil_clave"
  CHECK ("kind" <> 'PROFILE' OR ("pairKey" IS NOT NULL AND "pairKey" LIKE 'profile:%'));

-- Y al revés: una conversación de evento o sala no lleva NINGUNA de las cuatro
-- columnas del perfil. `conversations_perfil_campos` sola no basta: con
-- `eventId` puesto su lado derecho ya es false, así que una EVENT_DIRECT con
-- `requestStatus` pasaría.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_perfil_solo_en_perfil"
  CHECK ("kind" = 'PROFILE' OR ("requesterId" IS NULL AND "vendorProfileId" IS NULL
    AND "requestStatus" IS NULL AND "declinedAt" IS NULL));

-- CreateTable
CREATE TABLE "message_recipients" (
    "messageId" UUID NOT NULL,
    "userId" UUID NOT NULL,

    CONSTRAINT "message_recipients_pkey" PRIMARY KEY ("messageId","userId")
);

-- CreateIndex
CREATE INDEX "message_recipients_userId_messageId_idx" ON "message_recipients"("userId", "messageId");

-- AddForeignKey
ALTER TABLE "message_recipients" ADD CONSTRAINT "message_recipients_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_recipients" ADD CONSTRAINT "message_recipients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Una sala por evento: su `pairKey` es `room:<eventId>` (ver `claveDeSala`).
-- Con el UNIQUE de `pairKey` ya existente, dos salas del mismo evento chocan.
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_sala_clave"
  CHECK ("kind" <> 'EVENT_ROOM' OR ("eventId" IS NOT NULL AND "pairKey" = 'room:' || "eventId"::text));

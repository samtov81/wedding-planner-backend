-- CHECK (no lo modela Prisma): cada marca es un par (instante, id de mensaje)
-- y se escribe entera o no se escribe. Sin ellos una fila con sólo uno de los
-- dos valores haría que la comparación (at, id) diera NULL y el mensaje
-- contara como leído o no leído al azar.
ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_leido_par"
    CHECK (("readUpToAt" IS NULL) = ("readUpToId" IS NULL));

ALTER TABLE "conversation_participants" ADD CONSTRAINT "conversation_participants_recibido_par"
    CHECK (("deliveredUpToAt" IS NULL) = ("deliveredUpToId" IS NULL));

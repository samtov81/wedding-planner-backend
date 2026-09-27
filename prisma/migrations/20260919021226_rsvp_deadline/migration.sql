-- AlterTable
ALTER TABLE "events" ADD COLUMN     "rsvpDeadlineDays" INTEGER NOT NULL DEFAULT 14;

-- Rango 0–365 (spec bloque A §2). Prisma no modela CHECK: vive sólo aquí, como
-- el de event_vendors en la migración inicial.
ALTER TABLE "events" ADD CONSTRAINT "events_rsvp_deadline_days_rango"
  CHECK ("rsvpDeadlineDays" BETWEEN 0 AND 365);

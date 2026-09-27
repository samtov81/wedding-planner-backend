/*
  Warnings:

  - You are about to drop the column `venueLocation` on the `events` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('DRAFT', 'ACTIVE');

-- CreateEnum
CREATE TYPE "ScheduleItemStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'PAID');

-- AlterTable
ALTER TABLE "events"
ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'USD',
ADD COLUMN     "status" "EventStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "totalBudget" DECIMAL(12,2),
ADD COLUMN     "venueLat" DECIMAL(9,6),
ADD COLUMN     "venueLng" DECIMAL(9,6),
ADD COLUMN     "venueMapboxId" TEXT,
ADD COLUMN     "venueName" TEXT,
ALTER COLUMN "weddingDate" DROP NOT NULL;

-- Las filas existentes se crearon con fecha obligatoria: son eventos publicados.
-- Una vez rellenas, el default pasa a DRAFT para los eventos nuevos.
ALTER TABLE "events" ALTER COLUMN "status" SET DEFAULT 'DRAFT';

-- venueLocation era texto libre: se conserva como dirección, sin coordenadas.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "venueAddress" TEXT;
UPDATE "events" SET "venueAddress" = "venueLocation" WHERE "venueLocation" IS NOT NULL;
ALTER TABLE "events" DROP COLUMN "venueLocation";

-- CreateTable
CREATE TABLE "schedule_items" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "locationName" TEXT,
    "locationAddress" TEXT,
    "locationLat" DECIMAL(9,6),
    "locationLng" DECIMAL(9,6),
    "locationMapboxId" TEXT,
    "status" "ScheduleItemStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "eventVendorId" UUID,
    "payeeName" TEXT,
    "concept" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING',
    "dueDate" DATE,
    "paidAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_items_eventId_startsAt_idx" ON "schedule_items"("eventId", "startsAt");

-- CreateIndex
CREATE INDEX "expenses_eventId_createdAt_id_idx" ON "expenses"("eventId", "createdAt", "id");

-- CreateIndex
CREATE INDEX "expenses_eventVendorId_idx" ON "expenses"("eventVendorId");

-- AddForeignKey
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_eventVendorId_fkey" FOREIGN KEY ("eventVendorId") REFERENCES "event_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CheckConstraint
ALTER TABLE "events" ADD CONSTRAINT "events_venue_coords" CHECK (
  ("venueLat" IS NULL) = ("venueLng" IS NULL)
  AND ("venueLat" IS NULL OR "venueLat" BETWEEN -90 AND 90)
  AND ("venueLng" IS NULL OR "venueLng" BETWEEN -180 AND 180)
);
ALTER TABLE "events" ADD CONSTRAINT "events_total_budget_no_negativo"
  CHECK ("totalBudget" IS NULL OR "totalBudget" >= 0);
ALTER TABLE "events" ADD CONSTRAINT "events_activo_con_fecha"
  CHECK ("status" = 'DRAFT' OR "weddingDate" IS NOT NULL);

ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_rango"
  CHECK ("endsAt" IS NULL OR "endsAt" >= "startsAt");
ALTER TABLE "schedule_items" ADD CONSTRAINT "schedule_items_coords" CHECK (
  ("locationLat" IS NULL) = ("locationLng" IS NULL)
  AND ("locationLat" IS NULL OR "locationLat" BETWEEN -90 AND 90)
  AND ("locationLng" IS NULL OR "locationLng" BETWEEN -180 AND 180)
);

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_monto_positivo" CHECK ("amount" > 0);
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_origen_exclusivo"
  CHECK (("eventVendorId" IS NULL) <> ("payeeName" IS NULL));
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_pagado_con_fecha"
  CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL));

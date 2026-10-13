-- CreateEnum
CREATE TYPE "SeatingTableShape" AS ENUM ('ROUND', 'RECTANGULAR');

-- CreateEnum
CREATE TYPE "SeatingObjectKind" AS ENUM ('DANCE_FLOOR', 'STAGE', 'BAR', 'DESSERT_TABLE', 'ENTRANCE');

-- AlterTable
-- El DEFAULT 'ROUND' rellena las mesas que ya existían: hasta ahora todas eran redondas.
ALTER TABLE "seating_tables" ADD COLUMN     "shape" "SeatingTableShape" NOT NULL DEFAULT 'ROUND';

-- CreateTable
CREATE TABLE "seating_objects" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "kind" "SeatingObjectKind" NOT NULL,
    "label" TEXT NOT NULL,
    "x" INTEGER NOT NULL DEFAULT 0,
    "y" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seating_objects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seating_objects_eventId_createdAt_idx" ON "seating_objects"("eventId", "createdAt");

-- AddForeignKey
ALTER TABLE "seating_objects" ADD CONSTRAINT "seating_objects_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Posición y etiqueta viven también aquí: la base de datos es la última línea.
-- El tope de 30 objetos por evento cruza filas y lo aplica el caso de uso.
ALTER TABLE "seating_objects"
  ADD CONSTRAINT "seating_objects_posicion"
  CHECK ("x" >= 0 AND "y" >= 0);

ALTER TABLE "seating_objects"
  ADD CONSTRAINT "seating_objects_etiqueta"
  CHECK (char_length("label") BETWEEN 1 AND 60);

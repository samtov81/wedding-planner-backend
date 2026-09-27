-- CreateTable
CREATE TABLE "seating_tables" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "minSeats" INTEGER NOT NULL,
    "maxSeats" INTEGER NOT NULL,
    "seatCount" INTEGER NOT NULL,
    "x" INTEGER NOT NULL DEFAULT 0,
    "y" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seating_tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seat_assignments" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "tableId" UUID NOT NULL,
    "seatIndex" INTEGER NOT NULL,
    "guestId" UUID NOT NULL,
    "companionIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "seat_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "seating_tables_eventId_createdAt_idx" ON "seating_tables"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "seat_assignments_eventId_idx" ON "seat_assignments"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "seat_assignments_tableId_seatIndex_key" ON "seat_assignments"("tableId", "seatIndex");

-- CreateIndex
CREATE UNIQUE INDEX "seat_assignments_guestId_companionIndex_key" ON "seat_assignments"("guestId", "companionIndex");

-- AddForeignKey
ALTER TABLE "seating_tables" ADD CONSTRAINT "seating_tables_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "seating_tables"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_guestId_fkey" FOREIGN KEY ("guestId") REFERENCES "guests"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Los rangos viven también aquí: la base de datos es la última línea. Que el
-- asiento exista (seatIndex < seatCount de SU mesa) cruza tablas y no cabe en
-- un CHECK; lo garantiza el caso de uso con la mesa bloqueada.
ALTER TABLE "seating_tables"
  ADD CONSTRAINT "seating_tables_asientos_rango"
  CHECK ("minSeats" >= 1 AND "minSeats" <= "seatCount" AND "seatCount" <= "maxSeats" AND "maxSeats" <= 20);

ALTER TABLE "seating_tables"
  ADD CONSTRAINT "seating_tables_posicion"
  CHECK ("x" >= 0 AND "y" >= 0);

ALTER TABLE "seat_assignments"
  ADD CONSTRAINT "seat_assignments_indices"
  CHECK ("seatIndex" >= 0 AND "companionIndex" BETWEEN 0 AND 10);

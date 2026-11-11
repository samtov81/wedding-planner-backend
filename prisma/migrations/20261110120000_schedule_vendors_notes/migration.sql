-- CreateTable
CREATE TABLE "schedule_item_vendors" (
    "id" UUID NOT NULL,
    "scheduleItemId" UUID NOT NULL,
    "eventVendorId" UUID NOT NULL,
    "assignedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),

    CONSTRAINT "schedule_item_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_item_notes" (
    "id" UUID NOT NULL,
    "scheduleItemId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedule_item_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "schedule_item_vendors_eventVendorId_idx" ON "schedule_item_vendors"("eventVendorId");

-- CreateIndex
CREATE UNIQUE INDEX "schedule_item_vendors_scheduleItemId_eventVendorId_key" ON "schedule_item_vendors"("scheduleItemId", "eventVendorId");

-- CreateIndex
CREATE INDEX "schedule_item_notes_scheduleItemId_createdAt_idx" ON "schedule_item_notes"("scheduleItemId", "createdAt");

-- AddForeignKey
ALTER TABLE "schedule_item_vendors" ADD CONSTRAINT "schedule_item_vendors_scheduleItemId_fkey" FOREIGN KEY ("scheduleItemId") REFERENCES "schedule_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_item_vendors" ADD CONSTRAINT "schedule_item_vendors_eventVendorId_fkey" FOREIGN KEY ("eventVendorId") REFERENCES "event_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_item_vendors" ADD CONSTRAINT "schedule_item_vendors_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_item_notes" ADD CONSTRAINT "schedule_item_notes_scheduleItemId_fkey" FOREIGN KEY ("scheduleItemId") REFERENCES "schedule_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_item_notes" ADD CONSTRAINT "schedule_item_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Nota 1..2000 caracteres tras quitar los espacios de los extremos.
ALTER TABLE "schedule_item_notes" ADD CONSTRAINT "schedule_item_notes_cuerpo"
  CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000);

-- CreateTable
CREATE TABLE "moodboard_images" (
    "id" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "categoryId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "uploadedById" UUID NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "archivedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "moodboard_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moodboard_shares" (
    "id" UUID NOT NULL,
    "imageId" UUID NOT NULL,
    "eventVendorId" UUID NOT NULL,
    "sharedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "moodboard_shares_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "moodboard_notes" (
    "id" UUID NOT NULL,
    "imageId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "moodboard_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "moodboard_images_storageKey_key" ON "moodboard_images"("storageKey");

-- CreateIndex
CREATE INDEX "moodboard_images_eventId_createdAt_idx" ON "moodboard_images"("eventId", "createdAt");

-- CreateIndex
CREATE INDEX "moodboard_shares_eventVendorId_idx" ON "moodboard_shares"("eventVendorId");

-- CreateIndex
CREATE UNIQUE INDEX "moodboard_shares_imageId_eventVendorId_key" ON "moodboard_shares"("imageId", "eventVendorId");

-- CreateIndex
CREATE INDEX "moodboard_notes_imageId_createdAt_idx" ON "moodboard_notes"("imageId", "createdAt");

-- AddForeignKey
ALTER TABLE "moodboard_images" ADD CONSTRAINT "moodboard_images_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moodboard_images" ADD CONSTRAINT "moodboard_images_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "vendor_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moodboard_images" ADD CONSTRAINT "moodboard_images_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moodboard_images" ADD CONSTRAINT "moodboard_images_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moodboard_shares" ADD CONSTRAINT "moodboard_shares_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "moodboard_images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moodboard_shares" ADD CONSTRAINT "moodboard_shares_eventVendorId_fkey" FOREIGN KEY ("eventVendorId") REFERENCES "event_vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moodboard_shares" ADD CONSTRAINT "moodboard_shares_sharedById_fkey" FOREIGN KEY ("sharedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moodboard_notes" ADD CONSTRAINT "moodboard_notes_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "moodboard_images"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "moodboard_notes" ADD CONSTRAINT "moodboard_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- CHECK (no los modela Prisma).
-- Título 1..120 caracteres tras quitar los espacios de los extremos.
ALTER TABLE "moodboard_images" ADD CONSTRAINT "moodboard_images_titulo"
  CHECK (char_length(btrim("title")) BETWEEN 1 AND 120);

-- Dimensiones que manda el cliente para reservar la caja del masonry.
ALTER TABLE "moodboard_images" ADD CONSTRAINT "moodboard_images_dimensiones"
  CHECK ("width" BETWEEN 1 AND 20000 AND "height" BETWEEN 1 AND 20000);

-- Archivar fija quién y cuándo a la vez: ninguno o los dos.
ALTER TABLE "moodboard_images" ADD CONSTRAINT "moodboard_images_archivado_coherente"
  CHECK (("archivedAt" IS NULL) = ("archivedById" IS NULL));

-- Nota 1..2000 caracteres tras quitar los espacios de los extremos.
ALTER TABLE "moodboard_notes" ADD CONSTRAINT "moodboard_notes_cuerpo"
  CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000);

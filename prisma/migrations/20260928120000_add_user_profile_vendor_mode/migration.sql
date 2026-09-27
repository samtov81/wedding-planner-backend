-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avatarKey" TEXT;

-- AlterTable
ALTER TABLE "vendor_profiles" ADD COLUMN     "currency" CHAR(3) NOT NULL DEFAULT 'USD',
ADD COLUMN     "locationAddress" TEXT,
ADD COLUMN     "locationLat" DECIMAL(9,6),
ADD COLUMN     "locationLng" DECIMAL(9,6),
ADD COLUMN     "locationMapboxId" TEXT,
ADD COLUMN     "locationName" TEXT,
ADD COLUMN     "publications" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "quote" TEXT,
ADD COLUMN     "responseTime" TEXT,
ADD COLUMN     "tagline" TEXT,
ADD COLUMN     "yearsExperience" INTEGER;

-- CreateTable
CREATE TABLE "vendor_packages" (
    "id" UUID NOT NULL,
    "vendorProfileId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "vendor_packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_portfolio_images" (
    "id" UUID NOT NULL,
    "vendorProfileId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "alt" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_portfolio_images_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vendor_packages_vendorProfileId_position_idx" ON "vendor_packages"("vendorProfileId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_portfolio_images_storageKey_key" ON "vendor_portfolio_images"("storageKey");

-- CreateIndex
CREATE INDEX "vendor_portfolio_images_vendorProfileId_position_idx" ON "vendor_portfolio_images"("vendorProfileId", "position");

-- AddForeignKey
ALTER TABLE "vendor_packages" ADD CONSTRAINT "vendor_packages_vendorProfileId_fkey" FOREIGN KEY ("vendorProfileId") REFERENCES "vendor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_portfolio_images" ADD CONSTRAINT "vendor_portfolio_images_vendorProfileId_fkey" FOREIGN KEY ("vendorProfileId") REFERENCES "vendor_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Mismas reglas que el venue del evento (`events_venue_coords`): o hay par de
-- coordenadas válido o no hay ninguna.
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_location_coords" CHECK (
  ("locationLat" IS NULL) = ("locationLng" IS NULL)
  AND ("locationLat" IS NULL OR "locationLat" BETWEEN -90 AND 90)
  AND ("locationLng" IS NULL OR "locationLng" BETWEEN -180 AND 180)
);
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_experiencia"
  CHECK ("yearsExperience" IS NULL OR "yearsExperience" >= 0);

ALTER TABLE "vendor_packages" ADD CONSTRAINT "vendor_packages_precio_positivo"
  CHECK ("price" > 0);
ALTER TABLE "vendor_packages" ADD CONSTRAINT "vendor_packages_posicion"
  CHECK ("position" >= 0);
ALTER TABLE "vendor_portfolio_images" ADD CONSTRAINT "vendor_portfolio_images_posicion"
  CHECK ("position" >= 0);

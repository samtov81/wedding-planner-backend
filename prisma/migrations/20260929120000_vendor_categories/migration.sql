-- Catálogo cerrado de categorías de proveedor. Sustituye el texto libre de
-- vendor_profiles.category y event_vendors.category por una FK.

-- CreateTable
CREATE TABLE "vendor_categories" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_categories_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vendor_categories_slug_key" ON "vendor_categories"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_categories_name_key" ON "vendor_categories"("name");

ALTER TABLE "vendor_categories" ADD CONSTRAINT "vendor_categories_slug_formato"
  CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "vendor_categories" ADD CONSTRAINT "vendor_categories_posicion"
  CHECK ("position" >= 0);

-- Las categorías del export de diseño (design/stitch), unificando sus
-- sinónimos: event_settings (filtro y "Assign New Vendor"), budget manager,
-- invoices y moodboard. `id` explícito: la columna no tiene default en SQL
-- (Prisma lo genera en cliente).
INSERT INTO "vendor_categories" ("id", "slug", "name", "position") VALUES
  (gen_random_uuid(), 'venue', 'Venue', 0),
  (gen_random_uuid(), 'catering', 'Catering', 1),
  (gen_random_uuid(), 'photography', 'Photography', 2),
  (gen_random_uuid(), 'decor-floral', 'Decor & Floral', 3),
  (gen_random_uuid(), 'music-entertainment', 'Music & Entertainment', 4),
  (gen_random_uuid(), 'attire-beauty', 'Attire & Beauty', 5),
  (gen_random_uuid(), 'stationery', 'Stationery', 6),
  (gen_random_uuid(), 'media', 'Media', 7);

-- Conversión del texto libre anterior. Sólo los rótulos que el export usa
-- para cada categoría; cualquier otro valor aborta la migración (mejor que
-- asignar una categoría inventada). "Venue & Catering" también aborta: son
-- dos categorías y no hay forma de elegir una.
CREATE TEMPORARY TABLE "categoria_por_rotulo" ("rotulo" TEXT PRIMARY KEY, "slug" TEXT NOT NULL);
INSERT INTO "categoria_por_rotulo" VALUES
  ('venue', 'venue'),
  ('catering', 'catering'),
  ('photography', 'photography'),
  ('decor & floral', 'decor-floral'),
  ('floral & decor', 'decor-floral'),
  ('decor', 'decor-floral'),
  ('floral', 'decor-floral'),
  ('music & entertainment', 'music-entertainment'),
  ('entertainment', 'music-entertainment'),
  ('music & audio', 'music-entertainment'),
  ('attire & beauty', 'attire-beauty'),
  ('attire', 'attire-beauty'),
  ('stationery', 'stationery'),
  ('media', 'media');

-- vendor_profiles
DROP INDEX "vendor_profiles_category_status_idx";
ALTER TABLE "vendor_profiles" ADD COLUMN "categoryId" UUID;
UPDATE "vendor_profiles" AS vp
SET "categoryId" = c."id"
FROM "categoria_por_rotulo" AS r
JOIN "vendor_categories" AS c ON c."slug" = r."slug"
WHERE r."rotulo" = lower(btrim(vp."category"));

-- event_vendors
ALTER TABLE "event_vendors" ADD COLUMN "categoryId" UUID;
UPDATE "event_vendors" AS ev
SET "categoryId" = c."id"
FROM "categoria_por_rotulo" AS r
JOIN "vendor_categories" AS c ON c."slug" = r."slug"
WHERE r."rotulo" = lower(btrim(ev."category"));

DO $$
DECLARE
  sin_mapear TEXT;
BEGIN
  SELECT string_agg(DISTINCT "category", ', ') INTO sin_mapear FROM (
    SELECT "category" FROM "vendor_profiles" WHERE "categoryId" IS NULL
    UNION ALL
    SELECT "category" FROM "event_vendors" WHERE "categoryId" IS NULL
  ) AS pendientes;
  IF sin_mapear IS NOT NULL THEN
    RAISE EXCEPTION 'Categorías sin equivalente en vendor_categories: %', sin_mapear;
  END IF;
END $$;

DROP TABLE "categoria_por_rotulo";

ALTER TABLE "vendor_profiles" ALTER COLUMN "categoryId" SET NOT NULL, DROP COLUMN "category";
ALTER TABLE "event_vendors" ALTER COLUMN "categoryId" SET NOT NULL, DROP COLUMN "category";

-- CreateIndex
CREATE INDEX "vendor_profiles_categoryId_status_idx" ON "vendor_profiles"("categoryId", "status");

-- CreateIndex
CREATE INDEX "event_vendors_categoryId_idx" ON "event_vendors"("categoryId");

-- AddForeignKey
ALTER TABLE "vendor_profiles" ADD CONSTRAINT "vendor_profiles_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "vendor_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "event_vendors" ADD CONSTRAINT "event_vendors_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "vendor_categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

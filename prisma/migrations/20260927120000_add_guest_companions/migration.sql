-- AlterTable
ALTER TABLE "guests"
ADD COLUMN     "companionsAllowed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "companionsConfirmed" INTEGER;

-- Los límites viven también aquí: la base de datos es la última línea y
-- sobrevive a los bugs del código de aplicación. Confirmar más acompañantes de
-- los permitidos es imposible por construcción, no por disciplina.
ALTER TABLE "guests"
  ADD CONSTRAINT "guests_companions_allowed_rango"
  CHECK ("companionsAllowed" BETWEEN 0 AND 10);

ALTER TABLE "guests"
  ADD CONSTRAINT "guests_companions_confirmed_rango"
  CHECK ("companionsConfirmed" IS NULL OR "companionsConfirmed" BETWEEN 0 AND "companionsAllowed");

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "invoiceFileBytes" INTEGER,
ADD COLUMN     "invoiceFileKey" TEXT,
ADD COLUMN     "invoiceFileName" TEXT,
ADD COLUMN     "invoiceFileType" TEXT,
ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "subtotal" DECIMAL(12,2);

-- El subtotal (importe sin impuestos) es positivo y no supera el importe.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_subtotal_valido"
  CHECK ("subtotal" IS NULL OR ("subtotal" > 0 AND "subtotal" <= "amount"));

-- El archivo de la factura va entero o no va: sus cuatro campos a la vez.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_archivo_completo" CHECK (
  ("invoiceFileKey" IS NULL AND "invoiceFileName" IS NULL AND "invoiceFileType" IS NULL AND "invoiceFileBytes" IS NULL)
  OR ("invoiceFileKey" IS NOT NULL AND "invoiceFileName" IS NOT NULL AND "invoiceFileType" IS NOT NULL AND "invoiceFileBytes" IS NOT NULL));

-- Un número de factura no puede ser sólo espacios.
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_numero_no_vacio"
  CHECK ("invoiceNumber" IS NULL OR length(btrim("invoiceNumber")) > 0);

-- Mismo proveedor, mismo evento, mismo número: una sola vez. El proveedor es el
-- `eventVendorId` o, si es externo, su nombre sin distinguir mayúsculas. Índice
-- por expresión: Prisma no lo expresa y no lo declara en schema.prisma.
CREATE UNIQUE INDEX "expenses_invoice_number_unique" ON "expenses"
  ("eventId", COALESCE("eventVendorId"::text, lower("payeeName")), "invoiceNumber")
  WHERE "invoiceNumber" IS NOT NULL;

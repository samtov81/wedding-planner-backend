-- Un objeto de R2 pertenece a UN solo gasto: si dos filas compartieran la key,
-- borrar o reemplazar el archivo de una destruiría el de la otra. Índice único
-- parcial: Prisma no lo expresa y no lo declara en schema.prisma.
CREATE UNIQUE INDEX "expenses_invoice_file_key_unique" ON "expenses" ("invoiceFileKey")
  WHERE "invoiceFileKey" IS NOT NULL;

import { PrismaClient } from '@prisma/client'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'

/**
 * Las restricciones de factura de `expenses` (spec 2026-11-11 §6) viven en la
 * base y no sólo en el caso de uso: un segundo camino de escritura no puede
 * saltárselas. Se prueban con Prisma contra Postgres real; el mensaje del error
 * lleva el nombre de la constraint, que es lo que se exige aquí.
 */
/**
 * Prisma nombra la constraint en los errores de CHECK pero NO en los de un
 * índice único: informa de las columnas del índice (`P2002`). Como el índice
 * `expenses_invoice_number_unique` es por expresión, ese listado contiene la
 * expresión `COALESCE(...)`, que sólo este índice tiene en `expenses`.
 */
const UNICO_POR_PROVEEDOR = /Unique constraint failed on the fields:.*COALESCE/

describe('expenses: restricciones de factura', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let userId: string
  let eventoA: string
  let eventoB: string
  let proveedorA1: string
  let proveedorA2: string
  let proveedorB1: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    const user = await prisma.user.create({
      data: { email: 'owner@facturas.test', passwordHash: 'x', fullName: 'Owner' },
    })
    userId = user.id
    const categoryId = await categoriaId(prisma, 'music-entertainment')

    const crearEvento = async () =>
      (
        await prisma.event.create({
          data: { name: 'Boda', ownerId: userId, timezone: 'UTC', currency: 'USD' },
        })
      ).id
    const crearProveedor = async (eventId: string, nombre: string) =>
      (
        await prisma.eventVendor.create({
          data: {
            eventId,
            externalName: nombre,
            categoryId,
            assignedBudget: '1000.00',
            status: 'BOOKED',
          },
        })
      ).id

    eventoA = await crearEvento()
    eventoB = await crearEvento()
    proveedorA1 = await crearProveedor(eventoA, 'DJ')
    proveedorA2 = await crearProveedor(eventoA, 'Flores')
    proveedorB1 = await crearProveedor(eventoB, 'DJ')
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  /** Gasto PENDING de 100.00 con los campos mínimos; `extra` pisa lo que haga falta. */
  function gasto(eventId: string, extra: Record<string, unknown> = {}) {
    return prisma.expense.create({
      data: {
        eventId,
        concept: 'Servicio',
        category: 'music',
        amount: '100.00',
        createdById: userId,
        payeeName: 'Externo',
        ...extra,
      },
    })
  }

  describe('subtotal', () => {
    it('rechaza un subtotal de 0', async () => {
      await expect(gasto(eventoA, { subtotal: '0.00' })).rejects.toThrow(/expenses_subtotal_valido/)
    })

    it('rechaza un subtotal mayor que el importe', async () => {
      await expect(gasto(eventoA, { subtotal: '100.01' })).rejects.toThrow(
        /expenses_subtotal_valido/,
      )
    })

    it('acepta un subtotal igual al importe', async () => {
      await expect(gasto(eventoA, { subtotal: '100.00' })).resolves.toBeDefined()
    })
  })

  describe('archivo de factura', () => {
    it('rechaza un archivo con sólo la clave', async () => {
      await expect(gasto(eventoA, { invoiceFileKey: 'events/x/invoices/a.pdf' })).rejects.toThrow(
        /expenses_archivo_completo/,
      )
    })

    it('acepta el archivo con sus cuatro campos', async () => {
      await expect(
        gasto(eventoA, {
          invoiceFileKey: 'events/x/invoices/a.pdf',
          invoiceFileName: 'a.pdf',
          invoiceFileType: 'application/pdf',
          invoiceFileBytes: 1234,
        }),
      ).resolves.toBeDefined()
    })
  })

  describe('key del archivo', () => {
    const archivo = (key: string) => ({
      invoiceFileKey: key,
      invoiceFileName: 'a.pdf',
      invoiceFileType: 'application/pdf',
      invoiceFileBytes: 10,
    })

    it('rechaza la misma key de R2 en dos gastos', async () => {
      await gasto(eventoA, archivo('events/x/invoices/unica.pdf'))
      await expect(gasto(eventoB, archivo('events/x/invoices/unica.pdf'))).rejects.toThrow(
        /Unique constraint failed on the fields:.*invoiceFileKey/,
      )
    })

    it('acepta varios gastos sin archivo', async () => {
      await gasto(eventoA)
      await expect(gasto(eventoA)).resolves.toBeDefined()
    })
  })

  describe('número de factura', () => {
    it('rechaza un número en blanco', async () => {
      await expect(gasto(eventoA, { invoiceNumber: '   ' })).rejects.toThrow(
        /expenses_numero_no_vacio/,
      )
    })

    it('rechaza el mismo número del mismo proveedor en el mismo evento', async () => {
      await gasto(eventoA, { payeeName: null, eventVendorId: proveedorA1, invoiceNumber: 'F-1' })
      await expect(
        gasto(eventoA, { payeeName: null, eventVendorId: proveedorA1, invoiceNumber: 'F-1' }),
      ).rejects.toThrow(UNICO_POR_PROVEEDOR)
    })

    it('acepta el mismo número con otro proveedor', async () => {
      await gasto(eventoA, { payeeName: null, eventVendorId: proveedorA1, invoiceNumber: 'F-2' })
      await expect(
        gasto(eventoA, { payeeName: null, eventVendorId: proveedorA2, invoiceNumber: 'F-2' }),
      ).resolves.toBeDefined()
    })

    it('acepta el mismo número en otro evento', async () => {
      await gasto(eventoA, { payeeName: null, eventVendorId: proveedorA1, invoiceNumber: 'F-3' })
      await expect(
        gasto(eventoB, { payeeName: null, eventVendorId: proveedorB1, invoiceNumber: 'F-3' }),
      ).resolves.toBeDefined()
    })

    it('trata como el mismo beneficiario externo a "Ana" y "ANA"', async () => {
      await gasto(eventoA, { payeeName: 'Ana', invoiceNumber: 'F-4' })
      await expect(gasto(eventoA, { payeeName: 'ANA', invoiceNumber: 'F-4' })).rejects.toThrow(
        UNICO_POR_PROVEEDOR,
      )
    })

    it('acepta dos gastos sin número del mismo proveedor', async () => {
      await gasto(eventoA, { payeeName: null, eventVendorId: proveedorA1 })
      await expect(
        gasto(eventoA, { payeeName: null, eventVendorId: proveedorA1 }),
      ).resolves.toBeDefined()
    })
  })
})

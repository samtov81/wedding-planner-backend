import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { decodeCursor } from '@/shared/domain'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { ExpenseRepository } from '../application/expense.repository'
import { ExpenseRepositoryEnMemoria, type ProveedorEnMemoria } from './expense.repository.fake'
import { PrismaExpenseRepository } from './prisma-expense.repository'

const BASE = new Date('2026-03-01T00:00:00.000Z')

/**
 * Cada caso corre contra el doble y contra Postgres y compara lo que devuelve
 * el puerto (misma estructura que la paridad de eventos, Tarea 6). Cada test
 * siembra su PROPIO evento (y, si hace falta, sus proveedores) para no
 * arrastrar gastos de otros tests al comparar listados o sumas.
 */
describe('Paridad: ExpenseRepositoryEnMemoria vs PrismaExpenseRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let real: PrismaExpenseRepository
  let doble: ExpenseRepositoryEnMemoria
  let createdById: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    real = new PrismaExpenseRepository(prisma as unknown as PrismaService)
    doble = new ExpenseRepositoryEnMemoria()

    const owner = await prisma.user.create({
      data: { email: 'owner@gastos.test', passwordHash: 'x', fullName: 'Owner' },
    })
    createdById = owner.id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function sujetos(): Array<[string, ExpenseRepository]> {
    return [
      ['doble', doble],
      ['prisma', real],
    ]
  }

  /** Crea un evento en Postgres y opcionalmente sus `EventVendor`, sincronizados con el doble. */
  async function sembrarEvento(
    proveedores: Array<{
      name: string
      assignedBudget: string
      status: 'BOOKED' | 'CANCELLED'
    }> = [],
  ) {
    const evento = await prisma.event.create({
      data: { name: 'Boda', ownerId: createdById, timezone: 'UTC', currency: 'USD' },
    })
    const vendorIds: string[] = []
    for (const p of proveedores) {
      const fila = await prisma.eventVendor.create({
        data: {
          eventId: evento.id,
          externalName: p.name,
          categoryId: await categoriaId(prisma, 'music-entertainment'),
          assignedBudget: p.assignedBudget,
          status: p.status,
        },
      })
      const enMemoria: ProveedorEnMemoria = {
        id: fila.id,
        eventId: evento.id,
        name: p.name,
        assignedBudget: p.assignedBudget,
        status: p.status,
      }
      doble.proveedores.push(enMemoria)
      vendorIds.push(fila.id)
    }
    return { eventId: evento.id, vendorIds }
  }

  const sinVolatiles = ({
    id: _id,
    eventId: _e,
    createdById: _c,
    createdAt: _ca,
    updatedAt: _u,
    ...resto
  }: Record<string, unknown>) => resto

  it('crea un gasto de proveedor y uno externo, con su origen, amount y status', async () => {
    for (const [, repo] of sujetos()) {
      const { eventId, vendorIds } = await sembrarEvento([
        { name: 'DJ Max', assignedBudget: '500.00', status: 'BOOKED' },
      ])
      const vendorId = vendorIds[0]
      if (vendorId === undefined) throw new Error('vendor no sembrado')

      const deVendor = await repo.crear({
        eventId,
        origen: { kind: 'vendor', eventVendorId: vendorId },
        concept: 'Anticipo',
        category: 'Music',
        amount: '200.00',
        status: 'PENDING',
        paidAt: null,
        dueDate: null,
        notes: null,
        createdById,
      })
      expect(sinVolatiles({ ...deVendor })).toEqual({
        origen: { kind: 'vendor', eventVendorId: vendorId, vendorName: 'DJ Max' },
        concept: 'Anticipo',
        category: 'Music',
        amount: '200.00',
        status: 'PENDING',
        dueDate: null,
        paidAt: null,
        notes: null,
      })

      const externo = await repo.crear({
        eventId,
        origen: { kind: 'external', payeeName: 'Imprenta' },
        concept: 'Invitaciones',
        category: 'Papelería',
        amount: '50.00',
        status: 'PAID',
        paidAt: new Date('2026-03-05T00:00:00Z'),
        dueDate: null,
        notes: null,
        createdById,
      })
      expect(sinVolatiles({ ...externo })).toEqual({
        origen: { kind: 'external', payeeName: 'Imprenta' },
        concept: 'Invitaciones',
        category: 'Papelería',
        amount: '50.00',
        status: 'PAID',
        dueDate: null,
        paidAt: new Date('2026-03-05T00:00:00Z'),
        notes: null,
      })
    }
  })

  it('listar filtra por status, origin y eventVendorId, y pagina con limit 1 hasta agotar el cursor', async () => {
    for (const [, repo] of sujetos()) {
      const { eventId, vendorIds } = await sembrarEvento([
        { name: 'DJ Max', assignedBudget: '500.00', status: 'BOOKED' },
      ])
      const vendorId = vendorIds[0]
      if (vendorId === undefined) throw new Error('vendor no sembrado')

      const gastos = [
        {
          concept: 'G1',
          status: 'PENDING' as const,
          origen: { kind: 'vendor' as const, eventVendorId: vendorId },
        },
        {
          concept: 'G2',
          status: 'PAID' as const,
          origen: { kind: 'external' as const, payeeName: 'X' },
        },
        {
          concept: 'G3',
          status: 'PENDING' as const,
          origen: { kind: 'external' as const, payeeName: 'Y' },
        },
      ]
      for (const [i, g] of gastos.entries()) {
        const createdAt = new Date(BASE.getTime() + i * 60_000)
        if (repo === real) {
          await prisma.expense.create({
            data: {
              eventId,
              concept: g.concept,
              category: 'Otros',
              amount: '10.00',
              status: g.status,
              paidAt: g.status === 'PAID' ? createdAt : null,
              createdAt,
              createdById,
              ...(g.origen.kind === 'vendor'
                ? { eventVendorId: g.origen.eventVendorId }
                : { payeeName: g.origen.payeeName }),
            },
          })
        } else {
          doble.gastos.push({
            id: randomUUID(),
            eventId,
            origen: g.origen,
            concept: g.concept,
            category: 'Otros',
            amount: '10.00',
            status: g.status,
            dueDate: null,
            paidAt: g.status === 'PAID' ? createdAt : null,
            notes: null,
            createdById,
            createdAt,
            updatedAt: createdAt,
          })
        }
      }

      const porStatus = await repo.listar(
        eventId,
        { status: 'PENDING', origin: null, eventVendorId: null },
        null,
        20,
      )
      expect(porStatus.items.map((e) => e.concept)).toEqual(['G3', 'G1'])

      const porOrigin = await repo.listar(
        eventId,
        { status: null, origin: 'vendor', eventVendorId: null },
        null,
        20,
      )
      expect(porOrigin.items.map((e) => e.concept)).toEqual(['G1'])

      const porVendor = await repo.listar(
        eventId,
        { status: null, origin: null, eventVendorId: vendorId },
        null,
        20,
      )
      expect(porVendor.items.map((e) => e.concept)).toEqual(['G1'])

      // Ronda de arreglo 1 (I-1): `origin` y `eventVendorId` combinados deben
      // ANDearse, no que uno pise al otro. `origin: 'external'` +
      // `eventVendorId` de un vendor real es CONTRADICTORIO (G1 es el único
      // gasto de ese vendor y es 'vendor', no 'external') → vacío.
      const contradictorio = await repo.listar(
        eventId,
        { status: null, origin: 'external', eventVendorId: vendorId },
        null,
        20,
      )
      expect(contradictorio.items).toEqual([])

      // `origin: 'vendor'` + el mismo `eventVendorId` es REDUNDANTE pero
      // consistente: sigue devolviendo sólo G1.
      const vendorYOrigin = await repo.listar(
        eventId,
        { status: null, origin: 'vendor', eventVendorId: vendorId },
        null,
        20,
      )
      expect(vendorYOrigin.items.map((e) => e.concept)).toEqual(['G1'])

      // Pagina con limit: 1, en orden createdAt desc, hasta que nextCursor sea null.
      const conceptos: string[] = []
      let cursor: ReturnType<typeof decodeCursor> | null = null
      for (let i = 0; i < 10; i++) {
        const pagina = await repo.listar(
          eventId,
          { status: null, origin: null, eventVendorId: null },
          cursor,
          1,
        )
        const item = pagina.items[0]
        if (item !== undefined) conceptos.push(item.concept)
        if (pagina.nextCursor === null) break
        cursor = decodeCursor(pagina.nextCursor)
      }
      expect(conceptos).toEqual(['G3', 'G2', 'G1'])
    }
  })

  it('actualizar cambia el origen de vendor a externo', async () => {
    for (const [, repo] of sujetos()) {
      const { eventId, vendorIds } = await sembrarEvento([
        { name: 'DJ Max', assignedBudget: '500.00', status: 'BOOKED' },
      ])
      const vendorId = vendorIds[0]
      if (vendorId === undefined) throw new Error('vendor no sembrado')

      const creado = await repo.crear({
        eventId,
        origen: { kind: 'vendor', eventVendorId: vendorId },
        concept: 'Cambio de origen',
        category: 'Music',
        amount: '30.00',
        status: 'PENDING',
        paidAt: null,
        dueDate: null,
        notes: null,
        createdById,
      })
      const actualizado = await repo.actualizar(eventId, creado.id, {
        origen: { kind: 'external', payeeName: 'Ahora externo' },
      })
      expect(actualizado.origen).toEqual({ kind: 'external', payeeName: 'Ahora externo' })
    }
  })

  it('actualizar un gasto inexistente lanza GastoNoEncontradoError', async () => {
    for (const [, repo] of sujetos()) {
      const { eventId } = await sembrarEvento()
      await expect(
        repo.actualizar(eventId, '00000000-0000-4000-8000-000000000000', { concept: 'X' }),
      ).rejects.toMatchObject({ code: 'EXPENSE_NOT_FOUND' })
    }
  })

  it('sumas suma pagado y pendiente, y el assigned excluye CANCELLED', async () => {
    for (const [, repo] of sujetos()) {
      const { eventId, vendorIds } = await sembrarEvento([
        { name: 'DJ Max', assignedBudget: '500.00', status: 'BOOKED' },
        { name: 'Cancelado', assignedBudget: '999.00', status: 'CANCELLED' },
      ])
      const vendorId = vendorIds[0]
      if (vendorId === undefined) throw new Error('vendor no sembrado')

      await repo.crear({
        eventId,
        origen: { kind: 'external', payeeName: 'A' },
        concept: 'A',
        category: 'Otros',
        amount: '0.10',
        status: 'PAID',
        paidAt: new Date(),
        dueDate: null,
        notes: null,
        createdById,
      })
      await repo.crear({
        eventId,
        origen: { kind: 'external', payeeName: 'B' },
        concept: 'B',
        category: 'Otros',
        amount: '0.20',
        status: 'PAID',
        paidAt: new Date(),
        dueDate: null,
        notes: null,
        createdById,
      })
      await repo.crear({
        eventId,
        origen: { kind: 'vendor', eventVendorId: vendorId },
        concept: 'C',
        category: 'Music',
        amount: '100.00',
        status: 'PENDING',
        paidAt: null,
        dueDate: null,
        notes: null,
        createdById,
      })

      expect(await repo.sumas(eventId)).toEqual({
        assigned: '500.00',
        paid: '0.30',
        pending: '100.00',
      })
    }
  })

  it('sumasPorCategoria agrupa por categoría y estado', async () => {
    const { eventId } = await sembrarEvento()
    const gasto = (category: string, amount: string, status: 'PAID' | 'PENDING') => ({
      eventId,
      origen: { kind: 'external' as const, payeeName: 'X' },
      concept: category,
      category,
      amount,
      status,
      paidAt: status === 'PAID' ? new Date() : null,
      dueDate: null,
      notes: null,
      createdById,
    })
    for (const [, repo] of sujetos()) {
      await repo.crear(gasto('Flowers', '100.10', 'PAID'))
      await repo.crear(gasto('Flowers', '0.20', 'PENDING'))
      await repo.crear(gasto('Music', '500.00', 'PENDING'))
    }
    for (const [nombre, repo] of sujetos()) {
      const filas = await repo.sumasPorCategoria(eventId)
      const ordenadas = [...filas].sort((a, b) =>
        `${a.category}${a.status}`.localeCompare(`${b.category}${b.status}`),
      )
      expect(ordenadas, nombre).toEqual([
        { category: 'Flowers', status: 'PAID', amount: '100.10', count: 1 },
        { category: 'Flowers', status: 'PENDING', amount: '0.20', count: 1 },
        { category: 'Music', status: 'PENDING', amount: '500.00', count: 1 },
      ])
    }
  })
})

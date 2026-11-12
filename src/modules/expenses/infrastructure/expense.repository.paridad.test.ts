import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { decodeCursor } from '@/shared/domain'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { DatosNuevoGasto, ExpenseRepository } from '../application/expense.repository'
import { ExpenseRepositoryEnMemoria, type ProveedorEnMemoria } from './expense.repository.fake'
import { PrismaExpenseRepository } from './prisma-expense.repository'

const BASE = new Date('2026-03-01T00:00:00.000Z')
const HOY = '2026-03-10'

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
      status?: 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'
      /** Con `userId` el proveedor tiene ficha (`VendorProfile`) de ese usuario. */
      userId?: string
    }> = [],
  ) {
    const evento = await prisma.event.create({
      data: { name: 'Boda', ownerId: createdById, timezone: 'UTC', currency: 'USD' },
    })
    doble.eventos.push({ id: evento.id, name: 'Boda', currency: 'USD' })
    const vendorIds: string[] = []
    for (const p of proveedores) {
      const status = p.status ?? 'BOOKED'
      const perfil =
        p.userId === undefined
          ? null
          : ((await prisma.vendorProfile.findUnique({ where: { userId: p.userId } })) ??
            (await prisma.vendorProfile.create({
              data: {
                userId: p.userId,
                businessName: p.name,
                categoryId: await categoriaId(prisma, 'music-entertainment'),
              },
            })))
      const fila = await prisma.eventVendor.create({
        data: {
          eventId: evento.id,
          ...(perfil === null ? { externalName: p.name } : { vendorProfileId: perfil.id }),
          categoryId: await categoriaId(prisma, 'music-entertainment'),
          assignedBudget: p.assignedBudget,
          status,
        },
      })
      const enMemoria: ProveedorEnMemoria = {
        id: fila.id,
        eventId: evento.id,
        name: p.name,
        assignedBudget: p.assignedBudget,
        status,
        userId: p.userId ?? null,
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
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
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
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
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
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
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
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
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
            invoiceNumber: null,
            subtotal: null,
            invoiceFile: null,
            createdById,
            createdAt,
            updatedAt: createdAt,
          })
        }
      }

      const porStatus = await repo.listar(
        eventId,
        { status: 'PENDING', origin: null, eventVendorId: null, q: null, hoy: HOY },
        null,
        20,
      )
      expect(porStatus.items.map((e) => e.concept)).toEqual(['G3', 'G1'])

      const porOrigin = await repo.listar(
        eventId,
        { status: null, origin: 'vendor', eventVendorId: null, q: null, hoy: HOY },
        null,
        20,
      )
      expect(porOrigin.items.map((e) => e.concept)).toEqual(['G1'])

      const porVendor = await repo.listar(
        eventId,
        { status: null, origin: null, eventVendorId: vendorId, q: null, hoy: HOY },
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
        { status: null, origin: 'external', eventVendorId: vendorId, q: null, hoy: HOY },
        null,
        20,
      )
      expect(contradictorio.items).toEqual([])

      // `origin: 'vendor'` + el mismo `eventVendorId` es REDUNDANTE pero
      // consistente: sigue devolviendo sólo G1.
      const vendorYOrigin = await repo.listar(
        eventId,
        { status: null, origin: 'vendor', eventVendorId: vendorId, q: null, hoy: HOY },
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
          { status: null, origin: null, eventVendorId: null, q: null, hoy: HOY },
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
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
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
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
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
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
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
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
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
      invoiceNumber: null,
      subtotal: null,
      invoiceFile: null,
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

  async function usuario(): Promise<string> {
    const u = await prisma.user.create({
      data: { email: `${randomUUID()}@gastos.test`, passwordHash: 'x', fullName: 'Proveedor' },
    })
    return u.id
  }

  function nuevo(eventId: string, extra: Partial<DatosNuevoGasto> = {}): DatosNuevoGasto {
    return {
      eventId,
      origen: { kind: 'external', payeeName: 'Ana' },
      concept: 'Servicio',
      category: 'Otros',
      amount: '100.00',
      status: 'PENDING',
      paidAt: null,
      dueDate: null,
      notes: null,
      invoiceNumber: null,
      subtotal: null,
      invoiceFile: null,
      createdById,
      ...extra,
    }
  }

  const ARCHIVO = {
    key: 'events/x/invoices/a.pdf',
    name: 'a.pdf',
    contentType: 'application/pdf',
    bytes: 1234,
  }

  it('bloquearGasto devuelve lo mismo que buscarPorId y null desde otro evento', async () => {
    for (const [nombre, repo] of sujetos()) {
      const { eventId } = await sembrarEvento()
      const { eventId: otro } = await sembrarEvento()
      const creado = await repo.crear(
        nuevo(eventId, { invoiceNumber: 'F-09', subtotal: '80.00', invoiceFile: ARCHIVO }),
      )
      expect(await repo.bloquearGasto(eventId, creado.id), nombre).toEqual(
        await repo.buscarPorId(eventId, creado.id),
      )
      expect(await repo.bloquearGasto(otro, creado.id), nombre).toBeNull()
    }
  })

  it('crea con número, subtotal y archivo de factura, y actualizar los deja en null', async () => {
    for (const [nombre, repo] of sujetos()) {
      const { eventId } = await sembrarEvento()
      const creado = await repo.crear(
        nuevo(eventId, { invoiceNumber: 'F-01', subtotal: '80.00', invoiceFile: ARCHIVO }),
      )
      const releido = await repo.buscarPorId(eventId, creado.id)
      expect(releido, nombre).toMatchObject({
        invoiceNumber: 'F-01',
        subtotal: '80.00',
        invoiceFile: ARCHIVO,
      })
      const vacio = await repo.actualizar(eventId, creado.id, {
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
      })
      expect(vacio, nombre).toMatchObject({
        invoiceNumber: null,
        subtotal: null,
        invoiceFile: null,
      })
    }
  })

  it('listar con q busca por proveedor, concepto, número y beneficiario sin distinguir mayúsculas', async () => {
    const { eventId, vendorIds } = await sembrarEvento([
      { name: 'DJ Max', assignedBudget: '500.00' },
    ])
    const vendorId = vendorIds[0]
    if (vendorId === undefined) throw new Error('vendor no sembrado')
    for (const [nombre, repo] of sujetos()) {
      await repo.crear(
        nuevo(eventId, { concept: 'Pago A', origen: { kind: 'vendor', eventVendorId: vendorId } }),
      )
      await repo.crear(
        nuevo(eventId, {
          concept: 'Anticipo boda',
          origen: { kind: 'external', payeeName: 'Zeta' },
        }),
      )
      await repo.crear(
        nuevo(eventId, {
          concept: 'Pago C',
          invoiceNumber: 'F-0042',
          origen: { kind: 'external', payeeName: 'Zeta' },
        }),
      )
      await repo.crear(
        nuevo(eventId, { concept: 'Pago D', origen: { kind: 'external', payeeName: 'Ana Ruiz' } }),
      )
      const buscar = async (q: string) =>
        (
          await repo.listar(
            eventId,
            { status: null, origin: null, eventVendorId: null, q, hoy: HOY },
            null,
            20,
          )
        ).items
          .map((e) => e.concept)
          .sort()
      expect(await buscar('dj'), nombre).toEqual(['Pago A'])
      expect(await buscar('ANTICIPO'), nombre).toEqual(['Anticipo boda'])
      expect(await buscar('F-0'), nombre).toEqual(['Pago C'])
      expect(await buscar('ana'), nombre).toEqual(['Pago D'])
      expect(await buscar('nada'), nombre).toEqual([])
    }
  })

  /** Siembra PENDING con distintos `dueDate` respecto a `HOY` (2026-03-10) y un PAID vencido. */
  async function sembrarVencimientos(repo: ExpenseRepository, eventId: string) {
    const d = (dia: string) => new Date(`${dia}T00:00:00.000Z`)
    const casos: Array<[string, string | null, 'PENDING' | 'PAID', string]> = [
      ['V1', '2026-03-01', 'PENDING', '10.10'],
      ['V2', '2026-03-09', 'PENDING', '20.20'],
      ['HOY', '2026-03-10', 'PENDING', '5.00'],
      ['P1', '2026-03-11', 'PENDING', '1.00'],
      ['P2', '2026-03-12', 'PENDING', '1.00'],
      ['P3', '2026-03-13', 'PENDING', '1.00'],
      ['P4', '2026-03-14', 'PENDING', '1.00'],
      ['P5', '2026-03-15', 'PENDING', '1.00'],
      ['P6', '2026-03-16', 'PENDING', '1.00'],
      ['SIN', null, 'PENDING', '1.00'],
      ['PAGADO', '2026-03-02', 'PAID', '99.00'],
    ]
    for (const [concept, dia, status, amount] of casos) {
      await repo.crear(
        nuevo(eventId, {
          concept,
          amount,
          status,
          dueDate: dia === null ? null : d(dia),
          paidAt: status === 'PAID' ? new Date('2026-03-03T00:00:00Z') : null,
        }),
      )
    }
  }

  it('OVERDUE y vencidos devuelven sólo PENDING con dueDate anterior a hoy', async () => {
    const { eventId } = await sembrarEvento()
    for (const [nombre, repo] of sujetos()) {
      await sembrarVencimientos(repo, eventId)
      const pagina = await repo.listar(
        eventId,
        { status: 'OVERDUE', origin: null, eventVendorId: null, q: null, hoy: HOY },
        null,
        20,
      )
      expect(pagina.items.map((e) => e.concept).sort(), nombre).toEqual(['V1', 'V2'])
      expect(await repo.vencidos(eventId, HOY), nombre).toEqual({ amount: '30.30', count: 2 })
    }
  })

  it('proximos devuelve 5 por dueDate asc sin vencidos, pagados ni sin fecha', async () => {
    const { eventId } = await sembrarEvento()
    for (const [nombre, repo] of sujetos()) {
      await sembrarVencimientos(repo, eventId)
      const proximos = await repo.proximos(eventId, HOY, 5)
      expect(
        proximos.map((e) => e.concept),
        nombre,
      ).toEqual(['HOY', 'P1', 'P2', 'P3', 'P4'])
    }
  })

  it('listarPagosRecibidos y buscarPagoRecibido sólo ven PAID de BOOKED o CANCELLED propios', async () => {
    const yo = await usuario()
    const otro = await usuario()
    const e1 = await sembrarEvento([
      { name: 'Mi DJ', assignedBudget: '100.00', status: 'BOOKED', userId: yo },
      { name: 'Otro DJ', assignedBudget: '100.00', status: 'BOOKED', userId: otro },
    ])
    const e2 = await sembrarEvento([
      { name: 'Mi DJ', assignedBudget: '100.00', status: 'CANCELLED', userId: yo },
    ])
    const e3 = await sembrarEvento([
      { name: 'Mi DJ', assignedBudget: '100.00', status: 'SHORTLISTED', userId: yo },
    ])
    const externo = await sembrarEvento([{ name: 'Externo', assignedBudget: '100.00' }])
    const vid = (e: { vendorIds: string[] }, i = 0) => {
      const v = e.vendorIds.at(i)
      if (v === undefined) throw new Error('vendor no sembrado')
      return v
    }
    for (const [nombre, repo] of sujetos()) {
      const pago = (
        e: { eventId: string; vendorIds: string[] },
        i: number,
        concept: string,
        status: 'PAID' | 'PENDING',
        paidAt: string,
      ) =>
        repo.crear(
          nuevo(e.eventId, {
            concept,
            status,
            paidAt: status === 'PAID' ? new Date(paidAt) : null,
            invoiceNumber: `N-${concept}`,
            subtotal: '80.00',
            invoiceFile: ARCHIVO,
            origen: { kind: 'vendor', eventVendorId: vid(e, i) },
          }),
        )
      const reservado = await pago(e1, 0, 'reservado', 'PAID', '2026-03-05T00:00:00Z')
      await pago(e1, 0, 'pendiente', 'PENDING', '')
      const ajeno = await pago(e1, 1, 'ajeno', 'PAID', '2026-03-06T00:00:00Z')
      const cancelado = await pago(e2, 0, 'cancelado', 'PAID', '2026-03-07T00:00:00Z')
      const preseleccion = await pago(e3, 0, 'preseleccion', 'PAID', '2026-03-08T00:00:00Z')
      const deExterno = await repo.crear(
        nuevo(externo.eventId, {
          concept: 'externo',
          status: 'PAID',
          paidAt: new Date('2026-03-09T00:00:00Z'),
          origen: { kind: 'vendor', eventVendorId: vid(externo) },
        }),
      )

      const todos = await repo.listarPagosRecibidos(yo, null)
      expect(
        todos.map((p) => p.concept),
        nombre,
      ).toEqual(['cancelado', 'reservado'])
      expect(todos[1], nombre).toEqual({
        expenseId: reservado.id,
        eventId: e1.eventId,
        eventName: 'Boda',
        currency: 'USD',
        concept: 'reservado',
        amount: '100.00',
        subtotal: '80.00',
        invoiceNumber: 'N-reservado',
        paidAt: new Date('2026-03-05T00:00:00Z'),
        invoiceFile: ARCHIVO,
      })
      expect(
        (await repo.listarPagosRecibidos(yo, e1.eventId)).map((p) => p.concept),
        nombre,
      ).toEqual(['reservado'])

      expect((await repo.buscarPagoRecibido(yo, cancelado.id))?.concept, nombre).toBe('cancelado')
      for (const excluido of [ajeno, preseleccion, deExterno]) {
        expect(await repo.buscarPagoRecibido(yo, excluido.id), nombre).toBeNull()
      }
      const pendiente = (
        await repo.listar(
          e1.eventId,
          { status: 'PENDING', origin: null, eventVendorId: null, q: null, hoy: HOY },
          null,
          5,
        )
      ).items[0]
      expect(pendiente).toBeDefined()
      expect(await repo.buscarPagoRecibido(yo, pendiente?.id ?? ''), nombre).toBeNull()
    }
  })

  it('proveedorCobrable devuelve dueño y estado, y null para un externo', async () => {
    const yo = await usuario()
    const e = await sembrarEvento([
      { name: 'Con ficha', assignedBudget: '1.00', status: 'CANCELLED', userId: yo },
      { name: 'Externo', assignedBudget: '1.00' },
    ])
    for (const [nombre, repo] of sujetos()) {
      expect(await repo.proveedorCobrable(e.vendorIds[0] ?? ''), nombre).toEqual({
        userId: yo,
        status: 'CANCELLED',
      })
      expect(await repo.proveedorCobrable(e.vendorIds[1] ?? ''), nombre).toBeNull()
    }
  })

  it('un número repetido del mismo proveedor lanza NumeroDeFacturaRepetidoError al crear y al actualizar', async () => {
    const { eventId, vendorIds } = await sembrarEvento([
      { name: 'DJ Max', assignedBudget: '500.00' },
    ])
    const vendorId = vendorIds[0] ?? ''
    for (const [nombre, repo] of sujetos()) {
      const origen = { kind: 'vendor' as const, eventVendorId: vendorId }
      await repo.crear(nuevo(eventId, { origen, invoiceNumber: 'F-1' }))
      await expect(
        repo.crear(nuevo(eventId, { origen, invoiceNumber: 'F-1' })),
        nombre,
      ).rejects.toMatchObject({ code: 'INVOICE_NUMBER_TAKEN' })
      const otro = await repo.crear(nuevo(eventId, { origen }))
      await expect(
        repo.actualizar(eventId, otro.id, { invoiceNumber: 'F-1' }),
        nombre,
      ).rejects.toMatchObject({ code: 'INVOICE_NUMBER_TAKEN' })
    }
  })
})

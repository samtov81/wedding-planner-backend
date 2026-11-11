import { Prisma, PrismaClient } from '@prisma/client'

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import {
  AsignarProveedoresUseCase,
  ConfirmacionesUseCase,
} from '../application/participacion.use-cases'
import { PrismaScheduleItemRepository } from './prisma-schedule-item.repository'

/**
 * Lo que sólo Postgres puede probar de las asignaciones: el UNIQUE
 * `(scheduleItemId, eventVendorId)`, las dos cascadas (spec 2026-11-10 §9) y
 * la serialización de `bloquearItems`. El comportamiento del puerto se
 * compara con el doble en la paridad.
 */
describe('PrismaScheduleItemRepository (Postgres real)', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let repo: PrismaScheduleItemRepository
  let plannerId: string
  let eventId: string
  let categoryId: string
  let vendorProfileId: string
  let proveedorId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    repo = new PrismaScheduleItemRepository(prisma as unknown as PrismaService)
    plannerId = (
      await prisma.user.create({
        data: { email: 'planner@int-schedule.test', passwordHash: 'x', fullName: 'Planner' },
      })
    ).id
    eventId = (await prisma.event.create({ data: { name: 'Boda', ownerId: plannerId } })).id
    categoryId = (
      await prisma.vendorCategory.create({
        data: { slug: 'int-schedule', name: 'Int Schedule', position: 1 },
      })
    ).id
    const proveedor = await prisma.user.create({
      data: { email: 'prov@int-schedule.test', passwordHash: 'x', fullName: 'Prov' },
    })
    proveedorId = proveedor.id
    vendorProfileId = (
      await prisma.vendorProfile.create({
        data: { userId: proveedor.id, businessName: 'Prov', categoryId },
      })
    ).id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  /** Un ítem y una contratación BOOKED, con una asignación entre ambos. */
  async function asignado() {
    const item = await repo.crear({
      eventId,
      title: 'Ceremonia',
      description: null,
      startsAt: new Date('2027-06-12T18:00:00Z'),
      endsAt: null,
      location: null,
      status: 'PENDING',
    })
    const contratacion = await prisma.eventVendor.create({
      data: { eventId, categoryId, vendorProfileId, status: 'BOOKED' },
    })
    await repo.fijarAsignaciones(item.id, [contratacion.id], plannerId)
    return { itemId: item.id, eventVendorId: contratacion.id }
  }

  const filas = (where: Prisma.ScheduleItemVendorWhereInput) =>
    prisma.scheduleItemVendor.count({ where })

  it('una segunda fila (ítem, contratación) choca con el UNIQUE (P2002)', async () => {
    const { itemId, eventVendorId } = await asignado()

    const error: unknown = await prisma.scheduleItemVendor
      .create({ data: { scheduleItemId: itemId, eventVendorId, assignedById: plannerId } })
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError)
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2002')
  })

  it('borrar el ítem borra sus asignaciones', async () => {
    const { itemId, eventVendorId } = await asignado()
    expect(await filas({ scheduleItemId: itemId })).toBe(1)

    expect(await repo.eliminar(eventId, itemId)).toBe(true)

    expect(await filas({ scheduleItemId: itemId })).toBe(0)
    expect(await prisma.eventVendor.count({ where: { id: eventVendorId } })).toBe(1)
  })

  it('borrar la contratación borra sus asignaciones', async () => {
    const { itemId, eventVendorId } = await asignado()
    expect(await filas({ eventVendorId })).toBe(1)

    await prisma.eventVendor.delete({ where: { id: eventVendorId } })

    expect(await filas({ eventVendorId })).toBe(0)
    expect(await prisma.scheduleItem.count({ where: { id: itemId } })).toBe(1)
  })

  /**
   * `bloquearItems` (ruling T5): editar la hora, asignar y confirmar bloquean
   * las filas de los ítems implicados lo primero de su transacción. Cada caso
   * deja a A con el bloqueo tomado y su cambio escrito SIN confirmar hasta que
   * B (el caso de uso real) está esperando el bloqueo; entonces A confirma. Si
   * B no esperase (sin bloqueo), habría escrito antes de que A confirmara y
   * el resultado sería el de la carrera, no el serializado.
   */
  describe('bloquearItems', () => {
    async function esperarAQueAlguienEspere(): Promise<void> {
      for (let i = 0; i < 100; i++) {
        const [fila] = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()`
        if ((fila?.n ?? 0n) > 0n) return
        await new Promise((r) => setTimeout(r, 50))
      }
      // Si nadie llegó a esperar, el caso no probó la serialización: que falle
      // en voz alta en lugar de dar un verde que no vigila nada.
      throw new Error('ninguna sesión esperó un bloqueo (pg_stat_activity) en 5 s')
    }

    /** Un evento propio con un ítem y una contratación BOOKED del proveedor, ya asignada. */
    async function escenarioAislado() {
      const evento = await prisma.event.create({ data: { name: 'Lock', ownerId: plannerId } })
      const item = await repo.crear({
        eventId: evento.id,
        title: 'Ceremonia',
        description: null,
        startsAt: new Date('2027-06-12T18:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })
      const contratacion = await prisma.eventVendor.create({
        data: { eventId: evento.id, categoryId, vendorProfileId, status: 'BOOKED' },
      })
      return { eventId: evento.id, itemId: item.id, eventVendorId: contratacion.id }
    }

    it('Review Focus 1: un confirmar concurrente con un cambio de hora espera y deja el ítem pendiente', async () => {
      const servicio = prisma as unknown as PrismaService
      const unidad = new PrismaUnidadDeTrabajo(servicio)
      const { eventId: ev, itemId, eventVendorId } = await escenarioAislado()
      await repo.fijarAsignaciones(itemId, [eventVendorId], plannerId)
      const vistos = await repo.pendientesDe(ev, proveedorId)
      const nueva = new Date('2027-06-12T18:30:00Z')

      let avisarBloqueada: () => void = () => undefined
      const bloqueada = new Promise<void>((r) => (avisarBloqueada = r))
      const cambiarHora = unidad.ejecutar(async () => {
        await repo.bloquearItems(ev, [itemId])
        await repo.actualizar(ev, itemId, { startsAt: nueva })
        await repo.desconfirmarItem(itemId)
        avisarBloqueada()
        await esperarAQueAlguienEspere()
      })
      await bloqueada
      const confirmar = new ConfirmacionesUseCase(repo, unidad).confirmar(
        ev,
        proveedorId,
        vistos,
        true,
      )

      const [a, b] = await Promise.all([cambiarHora, confirmar])
      expect(a).toBeUndefined()
      expect(b.mine).toEqual({ pending: [{ itemId, startsAt: nueva, endsAt: null }] })
      expect(await filas({ scheduleItemId: itemId, confirmedAt: { not: null } })).toBe(0)
    }, 30_000)

    it('dos asignaciones concurrentes del mismo ítem se serializan sin chocar con el UNIQUE', async () => {
      const servicio = prisma as unknown as PrismaService
      const unidad = new PrismaUnidadDeTrabajo(servicio)
      const { eventId: ev, itemId, eventVendorId } = await escenarioAislado()

      let avisarBloqueada: () => void = () => undefined
      const bloqueada = new Promise<void>((r) => (avisarBloqueada = r))
      const primera = unidad.ejecutar(async () => {
        await repo.bloquearItems(ev, [itemId])
        const r = await repo.fijarAsignaciones(itemId, [eventVendorId], plannerId)
        avisarBloqueada()
        await esperarAQueAlguienEspere()
        return r
      })
      await bloqueada
      const segunda = new AsignarProveedoresUseCase(
        repo,
        unidad,
        new InMemoryQueueAdapter(),
      ).ejecutar(ev, itemId, { userId: plannerId, esPlanner: true }, [eventVendorId])

      const [a, b] = await Promise.allSettled([primera, segunda])
      expect(a).toMatchObject({ status: 'fulfilled', value: { altas: [eventVendorId] } })
      expect(b).toMatchObject({ status: 'fulfilled' })
      expect(await filas({ scheduleItemId: itemId })).toBe(1)
    }, 30_000)

    it('fuera de una transacción, con ids vacíos, ajenos o inexistentes, no falla ni cambia nada', async () => {
      const { eventId: ev, itemId } = await escenarioAislado()
      const otro = await escenarioAislado()

      await repo.bloquearItems(ev, [])
      await repo.bloquearItems(ev, [itemId, otro.itemId, '00000000-0000-4000-8000-000000000000'])
      await new UnidadDeTrabajoEnMemoria().ejecutar(() => repo.bloquearItems(ev, [itemId]))

      expect((await repo.buscarPorId(ev, itemId))?.title).toBe('Ceremonia')
    })
  })

  /**
   * El CHECK de la nota (1..2000 caracteres tras `btrim`) es la última defensa
   * si un caso de uso olvida validar. `$executeRaw` etiquetado: parametrizado,
   * nunca `$executeRawUnsafe` (prohibido por ESLint).
   */
  describe('CHECK de las notas', () => {
    async function insertar(cuerpo: string): Promise<unknown> {
      const { id } = await repo.crear({
        eventId,
        title: 'Con nota',
        description: null,
        startsAt: new Date('2027-06-12T18:00:00Z'),
        endsAt: null,
        location: null,
        status: 'PENDING',
      })
      return prisma.$executeRaw`INSERT INTO schedule_item_notes ("id", "scheduleItemId", "authorId", "body")
          VALUES (gen_random_uuid(), ${id}::uuid, ${plannerId}::uuid, ${cuerpo})`.catch(
        (e: unknown) => e,
      )
    }

    it('rechaza la nota vacía y la de sólo espacios', async () => {
      expect(String(await insertar(''))).toContain('schedule_item_notes_cuerpo')
      expect(String(await insertar('   '))).toContain('schedule_item_notes_cuerpo')
    })

    it('rechaza 2.001 caracteres y acepta 2.000', async () => {
      expect(String(await insertar('a'.repeat(2001)))).toContain('schedule_item_notes_cuerpo')
      expect(await insertar('a'.repeat(2000))).toBe(1)
    })
  })
})

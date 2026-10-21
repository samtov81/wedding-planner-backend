import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { decodeCursor } from '@/shared/domain'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { NotificationRepository } from '../application/notification.repository'
import { NotificationPortEnMemoria } from './notification.port.fake'
import { NotificationRepositoryEnMemoria } from './notification.repository.fake'
import { PrismaNotificationRepository } from './prisma-notification.repository'

/**
 * Ruling H1: un doble más permisivo que el adaptador real produce verdes falsos
 * en TODOS los tests de casos de uso que lo usan. `prisma-notification.repository.test.ts`
 * prueba Postgres y `notifications.use-cases.test.ts` usa el doble, pero nadie
 * comprobaba que los dos contesten lo MISMO.
 *
 * Aquí cada caso se escribe UNA vez y corre contra los dos: se siembran las
 * mismas filas (mismos ids y mismos `createdAt`, que es lo que ordena) y se
 * comparan las respuestas del puerto, no los detalles de cada implementación.
 */
const BASE = new Date('2026-03-01T00:00:00.000Z')

describe('Paridad: NotificationRepositoryEnMemoria vs PrismaNotificationRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let real: PrismaNotificationRepository
  let doble: NotificationRepositoryEnMemoria
  let eventId: string
  let otroEventId: string
  let miId: string
  let otroId: string

  /**
   * Siembra la MISMA fila en los dos. Prisma genera el id, y el doble copia
   * ese id: comparar listados por id sólo significa algo si son los mismos.
   */
  async function sembrarEnAmbos(datos: {
    userId: string
    eventId?: string
    minuto: number
    leida?: boolean
  }): Promise<string> {
    const createdAt = new Date(BASE.getTime() + datos.minuto * 60_000)
    const readAt = datos.leida === true ? BASE : null
    const fila = await prisma.notification.create({
      data: {
        eventId: datos.eventId ?? eventId,
        userId: datos.userId,
        type: 'guest.rsvp.updated',
        payload: { minuto: datos.minuto },
        createdAt,
        readAt,
      },
    })
    doble.filas.push({
      id: fila.id,
      eventId: datos.eventId ?? eventId,
      userId: datos.userId,
      type: 'guest.rsvp.updated',
      payload: { minuto: datos.minuto },
      createdAt,
      readAt,
    })
    return fila.id
  }

  /**
   * Los dos sujetos de cada caso. Es una función, no una constante: `real` y
   * `doble` se construyen en `beforeAll`/`beforeEach`, después de que se
   * evalúe el cuerpo del `describe`.
   */
  function implementaciones(): Array<[string, NotificationRepository]> {
    return [
      ['Prisma', real],
      ['doble', doble],
    ]
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    real = new PrismaNotificationRepository(prisma as unknown as PrismaService)

    const mio = await prisma.user.create({
      data: { email: 'mio@paridad.test', passwordHash: 'x', fullName: 'Mío' },
    })
    const otro = await prisma.user.create({
      data: { email: 'otro@paridad.test', passwordHash: 'x', fullName: 'Otro' },
    })
    miId = mio.id
    otroId = otro.id

    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12T00:00:00.000Z'), ownerId: miId },
    })
    const otroEvento = await prisma.event.create({
      data: { name: 'Otra', weddingDate: new Date('2027-07-12T00:00:00.000Z'), ownerId: miId },
    })
    eventId = evento.id
    otroEventId = otroEvento.id
    await prisma.eventMembership.createMany({
      data: [
        { eventId, userId: miId, role: 'COUPLE', status: 'ACTIVE' },
        { eventId, userId: otroId, role: 'PLANNER', status: 'ACTIVE' },
      ],
    })
  }, 240_000)

  beforeEach(async () => {
    await prisma.notification.deleteMany()
    doble = new NotificationRepositoryEnMemoria()
    doble.registrarMiembros(eventId, [miId, otroId])
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  describe('listar paginado', () => {
    it('en los dos: más recientes primero, sin las de otros usuarios ni de otro evento', async () => {
      const vieja = await sembrarEnAmbos({ userId: miId, minuto: 1 })
      const nueva = await sembrarEnAmbos({ userId: miId, minuto: 2 })
      await sembrarEnAmbos({ userId: otroId, minuto: 3 })
      await sembrarEnAmbos({ userId: miId, eventId: otroEventId, minuto: 4 })

      for (const [, repo] of implementaciones()) {
        const pagina = await repo.listar(eventId, miId, {
          desde: null,
          limite: 10,
          soloNoLeidas: false,
        })

        expect(pagina.items.map((n) => n.id)).toEqual([nueva, vieja])
        expect(pagina.nextCursor).toBeNull()
      }
    })

    it('recorre las páginas igual en los dos, con createdAt empatados', async () => {
      // Los empates en `createdAt` son donde un doble ingenuo se desvía: sin
      // desempate por `id`, salta filas o las repite a partir de la página 2.
      const ids: string[] = []
      for (let i = 0; i < 5; i += 1) {
        ids.push(await sembrarEnAmbos({ userId: miId, minuto: i % 2 }))
      }

      const recorrido = async (repo: NotificationRepository): Promise<string[]> => {
        const vistas: string[] = []
        let desde = null
        for (let vuelta = 0; vuelta < 10; vuelta += 1) {
          const pagina = await repo.listar(eventId, miId, { desde, limite: 2, soloNoLeidas: false })
          vistas.push(...pagina.items.map((n) => n.id))
          if (pagina.nextCursor === null) break
          desde = decodeCursor(pagina.nextCursor)
        }
        return vistas
      }

      const conPrisma = await recorrido(real)
      const conDoble = await recorrido(doble)

      expect(conPrisma).toHaveLength(5)
      expect(new Set(conPrisma)).toEqual(new Set(ids))
      // Mismo orden exacto, no sólo el mismo conjunto: el cursor de uno tiene
      // que valer en el otro.
      expect(conDoble).toEqual(conPrisma)
    })

    it('en los dos: soloNoLeidas deja fuera las leídas', async () => {
      await sembrarEnAmbos({ userId: miId, minuto: 1, leida: true })
      const noLeida = await sembrarEnAmbos({ userId: miId, minuto: 2 })

      for (const [, repo] of implementaciones()) {
        const pagina = await repo.listar(eventId, miId, {
          desde: null,
          limite: 10,
          soloNoLeidas: true,
        })

        expect(pagina.items.map((n) => n.id)).toEqual([noLeida])
      }
    })
  })

  it('contarNoLeidas cuenta lo mismo: sólo las mías, en este evento y sin leer', async () => {
    await sembrarEnAmbos({ userId: miId, minuto: 1 })
    await sembrarEnAmbos({ userId: miId, minuto: 2 })
    await sembrarEnAmbos({ userId: miId, minuto: 3, leida: true })
    await sembrarEnAmbos({ userId: otroId, minuto: 4 })
    await sembrarEnAmbos({ userId: miId, eventId: otroEventId, minuto: 5 })

    expect(await real.contarNoLeidas(eventId, miId)).toBe(2)
    expect(await doble.contarNoLeidas(eventId, miId)).toBe(2)
  })

  it('marcar leída es idempotente en los dos: el segundo marcado no mueve el readAt', async () => {
    const id = await sembrarEnAmbos({ userId: miId, minuto: 1 })
    const primera = new Date('2026-04-01T00:00:00.000Z')
    const despues = new Date('2026-05-01T00:00:00.000Z')

    for (const [, repo] of implementaciones()) {
      expect(await repo.marcarLeida(eventId, miId, id, primera)).toBe(true)
      expect(await repo.marcarLeida(eventId, miId, id, despues)).toBe(true)

      const pagina = await repo.listar(eventId, miId, {
        desde: null,
        limite: 10,
        soloNoLeidas: false,
      })
      expect(pagina.items[0]?.readAt).toEqual(primera)
    }
  })

  it('la notificación de OTRO usuario, o de otro evento, es "no encontrada" en los dos', async () => {
    const ajena = await sembrarEnAmbos({ userId: otroId, minuto: 1 })
    const deOtroEvento = await sembrarEnAmbos({ userId: miId, eventId: otroEventId, minuto: 2 })
    const ahora = new Date('2026-04-01T00:00:00.000Z')

    for (const [, repo] of implementaciones()) {
      expect(await repo.marcarLeida(eventId, miId, ajena, ahora)).toBe(false)
      expect(await repo.marcarLeida(eventId, miId, deOtroEvento, ahora)).toBe(false)
    }

    // Y no se marcó ninguna por el camino: seguirían sin leer para su dueño.
    expect(await real.contarNoLeidas(eventId, otroId)).toBe(1)
    expect(await doble.contarNoLeidas(eventId, otroId)).toBe(1)
  })

  it('destinatarios son los mismos miembros ACTIVOS en los dos', async () => {
    expect((await real.destinatarios(eventId)).sort()).toEqual(
      (await doble.destinatarios(eventId)).sort(),
    )
  })

  describe('a nivel de usuario', () => {
    /** Sin ids ni timestamps: lo que no es comparable entre los dos (ver `sinVolatiles`). */
    const sinVolatiles = (items: Array<{ id: string }>): unknown[] =>
      items.map(({ id: _id, ...resto }) => {
        const { createdAt: _c, ...sinFecha } = resto as Record<string, unknown>
        return sinFecha
      })

    async function fijarMembresiaEnOtroEvento(status: 'ACTIVE' | 'REVOKED'): Promise<void> {
      await prisma.eventMembership.upsert({
        where: { eventId_userId: { eventId: otroEventId, userId: miId } },
        create: { eventId: otroEventId, userId: miId, role: 'COUPLE', status },
        update: { status },
      })
      doble.registrarMiembros(otroEventId, status === 'ACTIVE' ? [miId] : [])
    }

    beforeEach(() => {
      doble.registrarEvento(eventId, 'Boda')
      doble.registrarEvento(otroEventId, 'Otra')
    })

    const todas = { desde: null, limite: 10, soloNoLeidas: false }

    it('listarDeUsuario mezcla eventos, más recientes primero, con el nombre del evento', async () => {
      await fijarMembresiaEnOtroEvento('ACTIVE')
      const enE1 = await sembrarEnAmbos({ userId: miId, minuto: 1 })
      const enE2 = await sembrarEnAmbos({ userId: miId, eventId: otroEventId, minuto: 2 })
      await sembrarEnAmbos({ userId: otroId, minuto: 3 })

      const conPrisma = await real.listarDeUsuario(miId, todas)
      const conDoble = await doble.listarDeUsuario(miId, todas)

      expect(conPrisma.items.map((n) => n.id)).toEqual([enE2, enE1])
      expect(conPrisma.items.map((n) => n.event)).toEqual([
        { id: otroEventId, name: 'Otra' },
        { id: eventId, name: 'Boda' },
      ])
      expect(conDoble.items.map((n) => n.id)).toEqual([enE2, enE1])
      expect(sinVolatiles(conDoble.items)).toEqual(sinVolatiles(conPrisma.items))
    })

    it('listarDeUsuario y contarNoLeidasDeUsuario ignoran eventos donde ya no es ACTIVE', async () => {
      await fijarMembresiaEnOtroEvento('REVOKED')
      const enE1 = await sembrarEnAmbos({ userId: miId, minuto: 1 })
      await sembrarEnAmbos({ userId: miId, minuto: 2, leida: true })
      await sembrarEnAmbos({ userId: miId, eventId: otroEventId, minuto: 3 })

      for (const [, repo] of implementaciones()) {
        const pagina = await repo.listarDeUsuario(miId, todas)
        expect(pagina.items.map((n) => n.event.id)).toEqual([eventId, eventId])
        expect(pagina.items.map((n) => n.id)).toContain(enE1)
        expect(await repo.contarNoLeidasDeUsuario(miId)).toBe(1)
      }
    })

    it('listarDeUsuario pagina igual en los dos con createdAt empatados', async () => {
      await fijarMembresiaEnOtroEvento('ACTIVE')
      for (let i = 0; i < 3; i += 1) await sembrarEnAmbos({ userId: miId, minuto: 5 })
      await sembrarEnAmbos({ userId: miId, eventId: otroEventId, minuto: 5 })

      const recorrido = async (repo: NotificationRepository): Promise<string[]> => {
        const vistas: string[] = []
        let desde = null
        for (let vuelta = 0; vuelta < 10; vuelta += 1) {
          const pagina = await repo.listarDeUsuario(miId, {
            desde,
            limite: 1,
            soloNoLeidas: false,
          })
          vistas.push(...pagina.items.map((n) => n.id))
          if (pagina.nextCursor === null) break
          desde = decodeCursor(pagina.nextCursor)
        }
        return vistas
      }

      const conPrisma = await recorrido(real)
      expect(conPrisma).toHaveLength(4)
      expect(new Set(conPrisma).size).toBe(4)
      expect(await recorrido(doble)).toEqual(conPrisma)
    })

    it('marcarTodasLeidas marca sólo las visibles y es idempotente', async () => {
      await fijarMembresiaEnOtroEvento('REVOKED')
      await sembrarEnAmbos({ userId: miId, minuto: 1 })
      await sembrarEnAmbos({ userId: miId, minuto: 2 })
      await sembrarEnAmbos({ userId: miId, minuto: 3, leida: true })
      await sembrarEnAmbos({ userId: miId, eventId: otroEventId, minuto: 4 })
      await sembrarEnAmbos({ userId: otroId, minuto: 5 })
      const ahora = new Date('2026-04-01T00:00:00.000Z')

      for (const [, repo] of implementaciones()) {
        expect(await repo.marcarTodasLeidas(miId, ahora)).toBe(2)
        expect(await repo.marcarTodasLeidas(miId, new Date('2026-05-01T00:00:00.000Z'))).toBe(0)
        expect(await repo.contarNoLeidasDeUsuario(miId)).toBe(0)
      }

      // La del evento revocado y la de otro usuario siguen sin leer.
      const enPrisma = await prisma.notification.findMany({ where: { readAt: null } })
      expect(enPrisma.map((f) => [f.userId, f.eventId]).sort()).toEqual(
        [
          [miId, otroEventId],
          [otroId, eventId],
        ].sort(),
      )
      const enDoble = doble.filas.filter((f) => f.readAt === null)
      expect(enDoble.map((f) => [f.userId, f.eventId]).sort()).toEqual(
        [
          [miId, otroEventId],
          [otroId, eventId],
        ].sort(),
      )
    })
  })

  describe('crearParaDueno (puerto de escritura)', () => {
    /** Lo que quedó escrito, sin ids ni fechas: lo comparable entre los dos. */
    const filasEnPrisma = async (): Promise<unknown[]> =>
      (await prisma.notification.findMany({ orderBy: { id: 'asc' } })).map((f) => ({
        eventId: f.eventId,
        userId: f.userId,
        tipo: f.type,
        payload: f.payload,
      }))

    it('crearParaDueno crea UNA fila, para el dueño, en los dos', async () => {
      const puerto = new NotificationPortEnMemoria()
      puerto.registrarMiembros(eventId, [miId, otroId])
      puerto.registrarDueno(eventId, miId)

      await real.crearParaDueno(eventId, 'event.member.responded', { response: 'ACCEPTED' })
      await puerto.crearParaDueno(eventId, 'event.member.responded', { response: 'ACCEPTED' })

      const esperado = [
        {
          eventId,
          userId: miId,
          tipo: 'event.member.responded',
          payload: { response: 'ACCEPTED' },
        },
      ]
      expect(await filasEnPrisma()).toEqual(esperado)
      expect(puerto.creadas).toEqual(esperado)
    })

    it('crearParaDueno con un evento que no existe no crea nada en los dos', async () => {
      const puerto = new NotificationPortEnMemoria()
      const inexistente = '99999999-9999-4999-8999-999999999999'

      await real.crearParaDueno(inexistente, 'event.member.responded', {})
      await puerto.crearParaDueno(inexistente, 'event.member.responded', {})

      expect(await filasEnPrisma()).toEqual([])
      expect(puerto.creadas).toEqual([])
    })
  })
})

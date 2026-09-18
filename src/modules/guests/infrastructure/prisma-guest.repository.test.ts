import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { decodeCursor } from '@/shared/domain'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { GuestFilters } from '../application/guest.repository'
import { EmailDuplicadoError } from '../domain/guest-errors'
import { GuestRepositoryEnMemoria } from './guest.repository.fake'
import { PrismaGuestRepository } from './prisma-guest.repository'

/**
 * PRNG determinista (mulberry32). `faker` está prohibido en este repo —la
 * 6.6.6 instalada está comprometida—, y un `Math.random()` haría que el mismo
 * test pasara hoy y fallara mañana sin que nadie hubiera tocado nada.
 */
function mulberry32(semilla: number): () => number {
  let a = semilla
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RSVPS = ['CONFIRMED', 'PENDING', 'DECLINED'] as const
const BASE = new Date('2026-01-01T00:00:00.000Z')

describe('PrismaGuestRepository — paginación por cursor', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let repo: PrismaGuestRepository
  let eventId: string
  let otroEventId: string

  async function crearInvitadoCon(datos: {
    nombre: string
    createdAt: Date
    email?: string
    grupo?: string
  }): Promise<string> {
    const fila = await prisma.guest.create({
      data: {
        eventId,
        name: datos.nombre,
        group: datos.grupo ?? 'Family',
        createdAt: datos.createdAt,
        ...(datos.email !== undefined ? { email: datos.email } : {}),
      },
    })
    return fila.id
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    // El repositorio sólo usa el cliente de Prisma; se le pasa el mismo que
    // siembra los datos en vez de abrir una segunda conexión para el test.
    repo = new PrismaGuestRepository(prisma as unknown as PrismaService)

    const owner = await prisma.user.create({
      data: { email: 'owner@guests.test', passwordHash: 'x', fullName: 'Owner' },
    })
    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12'), ownerId: owner.id },
    })
    const otro = await prisma.event.create({
      data: { name: 'Otra boda', weddingDate: new Date('2027-07-12'), ownerId: owner.id },
    })
    eventId = evento.id
    otroEventId = otro.id

    const aleatorio = mulberry32(20260917)
    for (let i = 0; i < 10; i += 1) {
      const rsvp = RSVPS[Math.floor(aleatorio() * RSVPS.length)] ?? 'PENDING'
      await prisma.guest.create({
        data: {
          eventId,
          name: `G0${i}`,
          email: `g0${i}@boda.test`,
          group: i < 5 ? 'Family' : 'Friends',
          rsvp,
          createdAt: new Date(BASE.getTime() + i * 1000),
        },
      })
    }
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('devuelve la primera página con su cursor', async () => {
    const pagina = await repo.listar(eventId, {}, null, 4)

    expect(pagina.items).toHaveLength(4)
    expect(pagina.items.map((g) => g.name)).toEqual(['G00', 'G01', 'G02', 'G03'])
    expect(pagina.nextCursor).not.toBeNull()
  })

  it('continúa exactamente donde lo dejó', async () => {
    const primera = await repo.listar(eventId, {}, null, 4)
    const segunda = await repo.listar(eventId, {}, decodeCursor(primera.nextCursor ?? ''), 4)

    expect(segunda.items.map((g) => g.name)).toEqual(['G04', 'G05', 'G06', 'G07'])
  })

  it('NO salta filas cuando alguien inserta mientras paginas', async () => {
    // Esto es lo que OFFSET hace mal y por lo que existe el cursor. Con
    // OFFSET 4, insertar una fila anterior desplaza todo y G03 se ve dos
    // veces mientras G04 no se ve nunca.
    const primera = await repo.listar(eventId, {}, null, 4)
    const intruso = await crearInvitadoCon({ nombre: 'Intruso', createdAt: new Date(0) })

    const segunda = await repo.listar(eventId, {}, decodeCursor(primera.nextCursor ?? ''), 4)

    expect(segunda.items.map((g) => g.name)).toEqual(['G04', 'G05', 'G06', 'G07'])

    await prisma.guest.delete({ where: { id: intruso } })
  })

  it('no pierde a nadie cuando dos invitados comparten el mismo createdAt', async () => {
    // El caso que `createdAt` a secas no sabe resolver: si el corte de página
    // cae entre dos filas con la misma marca de tiempo, un cursor que sólo
    // compara `createdAt > x` se salta la segunda. La tupla (createdAt, id)
    // es un orden total, así que aquí aparecen las dos.
    const mismoInstante = new Date(BASE.getTime() + 20_000)
    const a = await crearInvitadoCon({ nombre: 'Gemelo A', createdAt: mismoInstante })
    const b = await crearInvitadoCon({ nombre: 'Gemelo B', createdAt: mismoInstante })

    const vistos: string[] = []
    let cursor = null as ReturnType<typeof decodeCursor> | null
    // Páginas de UNA fila: así el corte cae necesariamente entre los dos
    // gemelos. El tope de vueltas sólo evita un bucle infinito si el cursor
    // dejara de avanzar.
    for (let i = 0; i < 50; i += 1) {
      const pagina = await repo.listar(eventId, {}, cursor, 1)
      vistos.push(...pagina.items.map((g) => g.name))
      if (pagina.nextCursor === null) break
      cursor = decodeCursor(pagina.nextCursor)
    }

    expect(vistos).toContain('Gemelo A')
    expect(vistos).toContain('Gemelo B')
    expect(new Set(vistos).size).toBe(vistos.length)

    await prisma.guest.deleteMany({ where: { id: { in: [a, b] } } })
  })

  it('devuelve nextCursor null en la última página', async () => {
    const ultima = await repo.listar(eventId, {}, null, 50)

    expect(ultima.nextCursor).toBeNull()
  })

  it('filtra por estado de RSVP', async () => {
    const confirmados = await repo.listar(eventId, { rsvp: 'CONFIRMED' }, null, 50)

    expect(confirmados.items.length).toBeGreaterThan(0)
    expect(confirmados.items.every((g) => g.rsvp === 'CONFIRMED')).toBe(true)
  })

  it('filtra por grupo', async () => {
    const amigos = await repo.listar(eventId, { group: 'Friends' }, null, 50)

    expect(amigos.items.length).toBeGreaterThan(0)
    expect(amigos.items.every((g) => g.group === 'Friends')).toBe(true)
  })

  it('busca por nombre y por email sin distinguir mayúsculas', async () => {
    const porNombre = await repo.listar(eventId, { q: 'g0' }, null, 50)
    expect(porNombre.items.length).toBeGreaterThan(0)

    const porEmail = await repo.listar(eventId, { q: 'G03@BODA' }, null, 50)
    expect(porEmail.items.map((g) => g.name)).toEqual(['G03'])
  })

  it('el cursor y el filtro `q` conviven: la segunda página sigue filtrada', async () => {
    // El `WHERE` del cursor y el del filtro `q` son los dos un `OR`. Puestos
    // los dos sueltos en el mismo objeto, el segundo pisa al primero y una de
    // las dos condiciones desaparece sin que nada falle: el cursor deja de
    // aplicarse en cuanto alguien busca. Por eso el del cursor va en su `AND`.
    // Filas que NO casan con `q`, intercaladas justo en el corte de página:
    // si el filtro se perdiera, aparecerían en la segunda página.
    const ruido: string[] = []
    for (let i = 0; i < 4; i += 1) {
      ruido.push(
        await crearInvitadoCon({
          nombre: `Ruido ${i}`,
          createdAt: new Date(BASE.getTime() + 3500 + i * 1000),
        }),
      )
    }

    const primera = await repo.listar(eventId, { q: 'g0' }, null, 4)
    expect(primera.items.map((g) => g.name)).toEqual(['G00', 'G01', 'G02', 'G03'])

    const segunda = await repo.listar(
      eventId,
      { q: 'g0' },
      decodeCursor(primera.nextCursor ?? ''),
      4,
    )

    expect(segunda.items.map((g) => g.name)).toEqual(['G04', 'G05', 'G06', 'G07'])

    await prisma.guest.deleteMany({ where: { id: { in: ruido } } })
  })

  it('el filtro combinado no cruza eventos', async () => {
    const deOtroEvento = await repo.listar(otroEventId, {}, null, 50)

    expect(deOtroEvento.items).toHaveLength(0)
  })

  it('cuenta por estado con un GROUP BY, con ceros para los estados vacíos', async () => {
    const conteo = await repo.contarPorEstado(otroEventId)

    expect(conteo).toEqual({ CONFIRMED: 0, PENDING: 0, DECLINED: 0 })

    const delEvento = await repo.contarPorEstado(eventId)
    expect(delEvento.CONFIRMED + delEvento.PENDING + delEvento.DECLINED).toBe(10)
  })

  it('traduce el índice único parcial (eventId, email) a EmailDuplicadoError', async () => {
    await expect(
      repo.crear({
        eventId,
        name: 'Repetido',
        email: 'g00@boda.test',
        group: 'Family',
        dietary: null,
      }),
    ).rejects.toBeInstanceOf(EmailDuplicadoError)
  })

  it('admite varios invitados sin email en el mismo evento', async () => {
    const uno = await repo.crear({
      eventId: otroEventId,
      name: 'Sin correo 1',
      email: null,
      group: 'Family',
      dietary: null,
    })
    const dos = await repo.crear({
      eventId: otroEventId,
      name: 'Sin correo 2',
      email: null,
      group: 'Family',
      dietary: null,
    })

    expect(uno.email).toBeNull()
    expect(dos.email).toBeNull()

    await prisma.guest.deleteMany({ where: { id: { in: [uno.id, dos.id] } } })
  })

  it('buscar, actualizar y borrar no cruzan de evento', async () => {
    const creado = await repo.crear({
      eventId,
      name: 'Para tocar',
      email: null,
      group: 'Work',
      dietary: null,
    })

    expect(await repo.buscar(otroEventId, creado.id)).toBeNull()
    expect(await repo.buscar(eventId, creado.id)).toMatchObject({ name: 'Para tocar' })

    const actualizado = await repo.actualizar(eventId, creado.id, { rsvp: 'CONFIRMED' })
    expect(actualizado.rsvp).toBe('CONFIRMED')

    await repo.borrar(otroEventId, creado.id)
    expect(await repo.buscar(eventId, creado.id)).not.toBeNull()

    await repo.borrar(eventId, creado.id)
    expect(await repo.buscar(eventId, creado.id)).toBeNull()
  })

  it('el doble en memoria no es más permisivo que Postgres', async () => {
    // Ruling H1: un doble que se desvía del adaptador real produce verdes
    // falsos en todos los tests de casos de uso que lo usan. Se siembra el
    // doble con las MISMAS filas y se comparan las respuestas.
    const fake = new GuestRepositoryEnMemoria()
    for (const g of await repo.listarTodos(eventId)) fake.sembrar(g)

    const casos: Array<[GuestFilters, number]> = [
      [{}, 4],
      [{}, 50],
      [{ rsvp: 'CONFIRMED' }, 50],
      [{ group: 'Friends' }, 3],
      [{ q: 'G0' }, 50],
    ]

    for (const [filtros, limite] of casos) {
      const real = await repo.listar(eventId, filtros, null, limite)
      const doble = await fake.listar(eventId, filtros, null, limite)
      expect(doble.items.map((g) => g.id)).toEqual(real.items.map((g) => g.id))
      expect(doble.nextCursor).toEqual(real.nextCursor)
    }

    expect(await fake.contarPorEstado(eventId)).toEqual(await repo.contarPorEstado(eventId))

    // Y la restricción que de verdad separa un doble ingenuo del real: el
    // índice único parcial (eventId, email).
    await expect(
      fake.crear({ eventId, name: 'Repetido', email: 'g00@boda.test', group: 'F', dietary: null }),
    ).rejects.toBeInstanceOf(EmailDuplicadoError)
  })

  it('listarTodos devuelve el evento entero en el mismo orden estable', async () => {
    const todos = await repo.listarTodos(eventId)

    expect(todos.map((g) => g.name)).toEqual([
      'G00',
      'G01',
      'G02',
      'G03',
      'G04',
      'G05',
      'G06',
      'G07',
      'G08',
      'G09',
    ])
  })
})

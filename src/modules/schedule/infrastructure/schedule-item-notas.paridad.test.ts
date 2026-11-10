import { PrismaClient } from '@prisma/client'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import {
  conAmbos as conAmbosEn,
  contratado,
  item,
  type Mundo,
} from './schedule-item.paridad.support'

/** Para que dos notas no compartan milisegundo: Postgres desempata por id, no por inserción. */
const pausa = () => new Promise((r) => setTimeout(r, 5))

/**
 * Paridad de las notas del planner y de las consultas de recordatorio (spec
 * 2026-11-10 §5 y §7): el mismo caso contra el doble y contra Postgres. Va en
 * su propio fichero para no engordar la paridad de asignaciones; el sembrado
 * es el arnés compartido.
 */
describe('Paridad: notas y recordatorios del cronograma', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let categoryId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    categoryId = (
      await prisma.vendorCategory.create({
        data: { slug: 'cronograma-paridad', name: 'Cronograma Paridad', position: 1 },
      })
    ).id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  const conAmbos = (caso: (m: Mundo, nombre: string) => Promise<void>) =>
    conAmbosEn(() => ({ prisma, categoryId }), caso)

  it('listarNotas devuelve las notas en orden cronológico con su autor', async () => {
    const resultados: unknown[] = []
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const ana = await m.usuario('Ana')
      const beto = await m.usuario('Beto')
      const a = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.crearNota(a.id, ana, 'Primera')
      await pausa()
      await m.repo.crearNota(a.id, beto, 'Segunda')
      await pausa()
      await m.repo.crearNota(a.id, ana, 'Tercera')

      const notas = await m.repo.listarNotas(a.id)
      resultados.push(
        notas.map((n) => ({
          body: n.body,
          autor: n.author.name,
          avatarKey: n.author.avatarKey,
          itemOk: n.itemId === a.id,
          autorOk: n.author.id === (n.author.name === 'Ana' ? ana : beto),
        })),
      )
    })
    expect((resultados[0] as { body: string }[]).map((n) => n.body)).toEqual([
      'Primera',
      'Segunda',
      'Tercera',
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('crearNota devuelve la nota con autor y avatarKey', async () => {
    const resultados: unknown[] = []
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const ana = await m.proveedor('Ana', 'users/ana/avatar.png')
      const a = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      const nota = await m.repo.crearNota(a.id, ana, 'Llegar antes')
      resultados.push({
        body: nota.body,
        author: { name: nota.author.name, avatarKey: nota.author.avatarKey },
        autorOk: nota.author.id === ana,
        itemOk: nota.itemId === a.id,
      })
    })
    expect(resultados[0]).toEqual({
      body: 'Llegar antes',
      author: { name: 'Ana', avatarKey: 'users/ana/avatar.png' },
      autorOk: true,
      itemOk: true,
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('contarNotas devuelve el número de cada ítem del evento y omite los que no tienen', async () => {
    const resultados: unknown[] = []
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const otroEvento = await m.evento()
      const ana = await m.usuario('Ana')
      const a = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      const b = await item(m, eventId, 'Fiesta', '2027-06-12T22:00:00Z')
      await item(m, eventId, 'Brindis', '2027-06-12T23:00:00Z')
      const ajeno = await item(m, otroEvento, 'Otra', '2027-06-12T18:00:00Z')
      await m.repo.crearNota(a.id, ana, '1')
      await m.repo.crearNota(a.id, ana, '2')
      await m.repo.crearNota(b.id, ana, '3')
      await m.repo.crearNota(ajeno.id, ana, '4')

      const cuentas = await m.repo.contarNotas(eventId)
      resultados.push({
        total: cuentas.size,
        a: cuentas.get(a.id),
        b: cuentas.get(b.id),
        ajeno: cuentas.get(ajeno.id),
      })
    })
    expect(resultados[0]).toEqual({ total: 2, a: 2, b: 1, ajeno: undefined })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('eliminar el ítem se lleva sus notas', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const ana = await m.usuario('Ana')
      const a = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.crearNota(a.id, ana, 'Hola')
      await m.repo.eliminar(eventId, a.id)
      expect((await m.repo.contarNotas(eventId)).size).toBe(0)
      expect(await m.repo.listarNotas(a.id)).toEqual([])
    })
  })

  it('destinoRecordatorio da null en sus 4 casos y el destino cuando es válido', async () => {
    const resultados: unknown[] = []
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const prov = await contratado(m, eventId, 'Banda Sol')
      const sinAsignar = await contratado(m, eventId, 'Fotos Mar')
      const a = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      await m.repo.fijarAsignaciones(a.id, [prov.eventVendorId], planner)

      const valido = await m.repo.destinoRecordatorio(a.id, prov.eventVendorId)
      const itemInexistente = await m.repo.destinoRecordatorio(
        '00000000-0000-4000-8000-000000000000',
        prov.eventVendorId,
      )
      const sinAsignacion = await m.repo.destinoRecordatorio(a.id, sinAsignar.eventVendorId)

      await m.cambiarContratacion(prov.eventVendorId, 'CANCELLED')
      const cancelada = await m.repo.destinoRecordatorio(a.id, prov.eventVendorId)
      await m.cambiarContratacion(prov.eventVendorId, 'BOOKED')
      const recontratada = await m.repo.destinoRecordatorio(a.id, prov.eventVendorId)

      await m.estadoEvento(eventId, 'DRAFT')
      const borrador = await m.repo.destinoRecordatorio(a.id, prov.eventVendorId)

      resultados.push({
        valido:
          valido === null
            ? null
            : {
                title: valido.title,
                status: valido.status,
                startsAt: valido.startsAt,
                userOk: valido.userId === prov.userId,
                eventOk: valido.eventId === eventId,
              },
        itemInexistente,
        sinAsignacion,
        cancelada,
        recontratada: recontratada !== null,
        borrador,
      })
    })
    expect(resultados[0]).toMatchObject({
      valido: {
        title: 'Ceremonia',
        status: 'PENDING',
        startsAt: new Date('2027-06-12T18:00:00Z'),
        userOk: true,
        eventOk: true,
      },
      itemInexistente: null,
      sinAsignacion: null,
      cancelada: null,
      recontratada: true,
      borrador: null,
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('destinoRecordatorio da null para una contratación externa asignada a la fuerza', async () => {
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const a = await item(m, eventId, 'Ceremonia', '2027-06-12T18:00:00Z')
      const externa = await m.contratacion({
        eventId,
        userId: null,
        name: 'Externo',
        status: 'BOOKED',
      })
      await m.repo.fijarAsignaciones(a.id, [externa], planner)
      expect(await m.repo.destinoRecordatorio(a.id, externa)).toBeNull()
    })
  })

  it('asignacionesFuturas excluye ítems pasados y asignaciones de otra contratación', async () => {
    const resultados: unknown[] = []
    await conAmbos(async (m) => {
      const eventId = await m.evento()
      const planner = await m.usuario('Planner')
      const prov = await contratado(m, eventId, 'Banda Sol')
      const otro = await contratado(m, eventId, 'Fotos Mar')
      const pasado = await item(m, eventId, 'Pasado', '2027-06-12T10:00:00Z')
      const tarde = await item(m, eventId, 'Tarde', '2027-06-12T22:00:00Z')
      const pronto = await item(m, eventId, 'Pronto', '2027-06-12T18:00:00Z')
      const deOtro = await item(m, eventId, 'DeOtro', '2027-06-12T19:00:00Z')
      const ahora = new Date('2027-06-12T12:00:00Z')
      await m.repo.fijarAsignaciones(pasado.id, [prov.eventVendorId], planner)
      await m.repo.fijarAsignaciones(tarde.id, [prov.eventVendorId], planner)
      await m.repo.fijarAsignaciones(pronto.id, [prov.eventVendorId], planner)
      await m.repo.fijarAsignaciones(deOtro.id, [otro.eventVendorId], planner)

      const futuras = await m.repo.asignacionesFuturas(prov.eventVendorId, ahora)
      const cancelada = await (async () => {
        await m.cambiarContratacion(prov.eventVendorId, 'CANCELLED')
        return m.repo.asignacionesFuturas(prov.eventVendorId, ahora)
      })()
      resultados.push({
        titulos: futuras.map((f) => [pronto, tarde].find((i) => i.id === f.itemId)?.title ?? '?'),
        horas: futuras.map((f) => f.startsAt),
        cancelada,
      })
    })
    expect(resultados[0]).toEqual({
      titulos: ['Pronto', 'Tarde'],
      horas: [new Date('2027-06-12T18:00:00Z'), new Date('2027-06-12T22:00:00Z')],
      cancelada: [],
    })
    expect(resultados[1]).toEqual(resultados[0])
  })
})

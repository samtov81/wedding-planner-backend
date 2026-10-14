import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { EventRepository } from '../application/event.repository'
import { EventRepositoryEnMemoria } from './event.repository.fake'
import { PrismaEventRepository } from './prisma-event.repository'

const VENUE = {
  name: 'Hacienda',
  address: 'Km 5 vía La Calera',
  lat: 4.712345,
  lng: -73.912345,
  mapboxId: 'poi.1',
}

/**
 * Cada caso corre contra el doble y contra Postgres y compara lo que devuelve
 * el puerto (ruling H1). Lo que no puede compararse (ids, timestamps) se
 * excluye con `sinVolatiles`.
 */
describe('Paridad: EventRepositoryEnMemoria vs PrismaEventRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let ownerId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const owner = await prisma.user.create({
      data: { email: 'owner@paridad.test', passwordHash: 'x', fullName: 'Owner' },
    })
    ownerId = owner.id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function sujetos(): Array<[string, EventRepository]> {
    const doble = new EventRepositoryEnMemoria()
    doble.usuarios.push({ id: ownerId, fullName: 'Owner', email: 'owner@paridad.test' })
    return [
      ['doble', doble],
      ['prisma', new PrismaEventRepository(prisma as unknown as PrismaService)],
    ]
  }

  /** Usuario nuevo invitado al evento por el puerto; devuelve su membresía. */
  async function invitar(
    repo: EventRepository,
    eventId: string,
    etiqueta: string,
    role: 'COUPLE' | 'PLANNER' = 'PLANNER',
  ) {
    const u = await prisma.user.create({
      data: {
        email: `${etiqueta}-${randomUUID()}@paridad.test`,
        passwordHash: 'x',
        fullName: etiqueta,
      },
    })
    if (repo instanceof EventRepositoryEnMemoria) {
      repo.usuarios.push({ id: u.id, fullName: etiqueta, email: u.email })
    }
    const m = await repo.invitarMiembro({ eventId, userId: u.id, role, invitedById: ownerId })
    return { userId: u.id, membershipId: m.id }
  }

  const sinVolatiles = ({
    id: _id,
    createdAt: _c,
    updatedAt: _u,
    ownerId: _o,
    ...resto
  }: Record<string, unknown>) => resto

  it('crea un borrador solo con nombre, con los defaults de la columna', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      resultados.push(
        sinVolatiles({ ...(await repo.crearConMembresia({ name: 'Boda', ownerId })) }),
      )
    }
    expect(resultados[0]).toEqual({
      name: 'Boda',
      status: 'DRAFT',
      weddingDate: null,
      timezone: 'UTC',
      currency: 'USD',
      totalBudget: null,
      venue: null,
      rsvpDeadlineDays: 14,
      conteos: { scheduleItems: 0, vendors: 0 },
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('crea con todos los campos y los devuelve normalizados', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({
        name: 'Boda',
        ownerId,
        weddingDate: new Date('2027-06-12T00:00:00Z'),
        timezone: 'America/Bogota',
        currency: 'COP',
        totalBudget: '45000000.00',
        venue: VENUE,
      })
      resultados.push(sinVolatiles({ ...evento }))
    }
    expect(resultados[0]).toMatchObject({
      totalBudget: '45000000.00',
      venue: VENUE,
      currency: 'COP',
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizar aplica solo lo que llega y null borra', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const creado = await repo.crearConMembresia({
        name: 'Boda',
        ownerId,
        totalBudget: '100.00',
        venue: VENUE,
      })
      const actualizado = await repo.actualizar(creado.id, {
        name: 'Boda de Ana',
        venue: null,
        weddingDate: new Date('2027-01-01T00:00:00Z'),
      })
      resultados.push(sinVolatiles({ ...actualizado }))
    }
    expect(resultados[0]).toMatchObject({
      name: 'Boda de Ana',
      venue: null,
      totalBudget: '100.00',
      weddingDate: new Date('2027-01-01T00:00:00Z'),
    })
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizar un evento inexistente lanza EventoNoEncontradoError', async () => {
    for (const [, repo] of sujetos()) {
      await expect(
        repo.actualizar('00000000-0000-4000-8000-000000000000', { name: 'X' }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
  })

  it('publicarSiCompleto publica un DRAFT completo y es null si le falta algo o ya no es DRAFT', async () => {
    for (const [, repo] of sujetos()) {
      const completo = await repo.crearConMembresia({
        name: 'Boda',
        ownerId,
        weddingDate: new Date('2027-06-12T00:00:00Z'),
        totalBudget: '100.00',
        venue: VENUE,
      })
      const publicado = await repo.publicarSiCompleto(completo.id)
      expect(publicado?.status).toBe('ACTIVE')
      // Ya no es DRAFT: una segunda llamada no hace nada.
      expect(await repo.publicarSiCompleto(completo.id)).toBeNull()

      const incompleto = await repo.crearConMembresia({ name: 'Boda a medias', ownerId })
      expect(await repo.publicarSiCompleto(incompleto.id)).toBeNull()
      expect((await repo.buscarPorId(incompleto.id))?.status).toBe('DRAFT')
    }
  })

  it('buscarMembresiaActiva marca owner sólo para quien creó el evento', async () => {
    const otro = await prisma.user.create({
      data: { email: 'pareja-2@paridad.test', passwordHash: 'x', fullName: 'Pareja 2' },
    })
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      if (repo instanceof EventRepositoryEnMemoria) {
        repo.membresias.push({
          eventId: evento.id,
          userId: otro.id,
          role: 'COUPLE',
          status: 'ACTIVE',
        })
      } else {
        await prisma.eventMembership.create({
          data: { eventId: evento.id, userId: otro.id, role: 'COUPLE', status: 'ACTIVE' },
        })
      }

      expect(await repo.buscarMembresiaActiva(evento.id, ownerId), nombre).toEqual({
        role: 'COUPLE',
        owner: true,
        budgetView: false,
      })
      expect(await repo.buscarMembresiaActiva(evento.id, otro.id), nombre).toEqual({
        role: 'COUPLE',
        owner: false,
        budgetView: false,
      })
    }
  })

  it('buscarMembresiaActiva lee el grant de presupuesto en la misma consulta', async () => {
    const otro = await prisma.user.create({
      data: { email: `grant-${Date.now()}@paridad.test`, passwordHash: 'x', fullName: 'Con grant' },
    })
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      if (repo instanceof EventRepositoryEnMemoria) {
        repo.membresias.push({
          id: `m-${nombre}`,
          eventId: evento.id,
          userId: otro.id,
          role: 'PLANNER',
          status: 'ACTIVE',
          budgetView: true,
        })
      } else {
        const m = await prisma.eventMembership.create({
          data: { eventId: evento.id, userId: otro.id, role: 'PLANNER', status: 'ACTIVE' },
        })
        await prisma.eventBudgetGrant.create({ data: { membershipId: m.id, grantedById: ownerId } })
      }
      expect(await repo.buscarMembresiaActiva(evento.id, otro.id), nombre).toEqual({
        role: 'PLANNER',
        owner: false,
        budgetView: true,
      })
    }
  })

  it('listarAccesiblesPor devuelve el grant de quien pregunta en cada evento', async () => {
    const miembro = await prisma.user.create({
      data: { email: `lista-${Date.now()}@paridad.test`, passwordHash: 'x', fullName: 'Lista' },
    })
    for (const [nombre, repo] of sujetos()) {
      const conGrant = await repo.crearConMembresia({ name: 'Con grant', ownerId })
      const sinGrant = await repo.crearConMembresia({ name: 'Sin grant', ownerId })
      for (const [evento, budgetView] of [
        [conGrant, true],
        [sinGrant, false],
      ] as const) {
        if (repo instanceof EventRepositoryEnMemoria) {
          repo.membresias.push({
            id: `${nombre}-${evento.id}`,
            eventId: evento.id,
            userId: miembro.id,
            role: 'COUPLE',
            status: 'ACTIVE',
            budgetView,
          })
        } else {
          const m = await prisma.eventMembership.create({
            data: { eventId: evento.id, userId: miembro.id, role: 'COUPLE', status: 'ACTIVE' },
          })
          if (budgetView) {
            await prisma.eventBudgetGrant.create({
              data: { membershipId: m.id, grantedById: ownerId },
            })
          }
        }
      }
      const lista = await repo.listarAccesiblesPor(miembro.id)
      const porNombre = Object.fromEntries(lista.map((a) => [a.evento.name, a.budgetView]))
      expect(porNombre, nombre).toMatchObject({ 'Con grant': true, 'Sin grant': false })
    }
  })

  it('listarMiembros: creador primero, INVITED y ACTIVE, sin REVOKED, con grant', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const ana = await invitar(repo, evento.id, 'Ana', 'COUPLE')
      await invitar(repo, evento.id, 'Pia')
      const fuera = await invitar(repo, evento.id, 'Fuera')
      await repo.aceptarInvitacion(evento.id, ana.userId)
      await repo.actualizarMembresia(evento.id, ana.membershipId, { budgetView: true }, ownerId)
      await repo.revocarMembresia(evento.id, fuera.membershipId, ownerId, 'revoked')
      resultados.push(
        (await repo.listarMiembros(evento.id)).map(
          ({ id: _i, userId: _u, email: _e, ...resto }) => resto,
        ),
      )
    }
    expect(resultados[0]).toEqual([
      { fullName: 'Owner', role: 'COUPLE', status: 'ACTIVE', owner: true, budgetView: false },
      { fullName: 'Ana', role: 'COUPLE', status: 'ACTIVE', owner: false, budgetView: true },
      { fullName: 'Pia', role: 'PLANNER', status: 'INVITED', owner: false, budgetView: false },
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('actualizarMembresia cambia rol y grant; cambiar el rol conserva el grant', async () => {
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const m = await invitar(repo, evento.id, 'Rol')
      expect(
        await repo.actualizarMembresia(evento.id, m.membershipId, { budgetView: true }, ownerId),
      ).toBe(true)
      expect(
        await repo.actualizarMembresia(evento.id, m.membershipId, { role: 'COUPLE' }, ownerId),
      ).toBe(true)
      expect(await repo.buscarMembresiaPorId(evento.id, m.membershipId), nombre).toMatchObject({
        role: 'COUPLE',
        status: 'INVITED',
        owner: false,
        budgetView: true,
      })
      expect(
        await repo.actualizarMembresia(evento.id, m.membershipId, { budgetView: false }, ownerId),
      ).toBe(true)
      expect((await repo.buscarMembresiaPorId(evento.id, m.membershipId))?.budgetView, nombre).toBe(
        false,
      )
      // De otro evento: no existe.
      const otro = await repo.crearConMembresia({ name: 'Otra', ownerId })
      expect(await repo.buscarMembresiaPorId(otro.id, m.membershipId), nombre).toBeNull()
      expect(
        await repo.actualizarMembresia(otro.id, m.membershipId, { role: 'PLANNER' }, ownerId),
      ).toBe(false)
    }
  })

  it('rechazar una invitación ya aceptada no la revoca: sigue ACTIVE', async () => {
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const m = await invitar(repo, evento.id, 'Aceptada')
      expect(await repo.aceptarInvitacion(evento.id, m.userId)).toBe(true)
      expect(await repo.revocarMembresia(evento.id, m.membershipId, m.userId, 'declined')).toBe(
        false,
      )
      expect(await repo.buscarMembresiaPorId(evento.id, m.membershipId), nombre).toMatchObject({
        status: 'ACTIVE',
      })
    }
  })

  it('revocar borra el grant; reinvitar nace sin grant aunque quedara uno huérfano', async () => {
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const m = await invitar(repo, evento.id, 'Revocado')
      await repo.actualizarMembresia(evento.id, m.membershipId, { budgetView: true }, ownerId)
      expect(await repo.revocarMembresia(evento.id, m.membershipId, ownerId, 'revoked')).toBe(true)
      expect(await repo.buscarMembresiaPorId(evento.id, m.membershipId), nombre).toMatchObject({
        status: 'REVOKED',
        budgetView: false,
      })
      // Revocar dos veces: la segunda no escribe.
      expect(await repo.revocarMembresia(evento.id, m.membershipId, ownerId, 'revoked')).toBe(false)
      // Grant huérfano sobre la REVOKED (la carrera grant/revocar): reinvitar lo limpia.
      if (repo instanceof EventRepositoryEnMemoria) {
        const fila = repo.membresias.find((x) => x.id === m.membershipId)
        if (fila !== undefined) fila.budgetView = true
      } else {
        await prisma.eventBudgetGrant.create({
          data: { membershipId: m.membershipId, grantedById: ownerId },
        })
      }
      await repo.invitarMiembro({
        eventId: evento.id,
        userId: m.userId,
        role: 'PLANNER',
        invitedById: ownerId,
      })
      expect((await repo.buscarMembresiaPorId(evento.id, m.membershipId))?.budgetView, nombre).toBe(
        false,
      )
    }
  })

  it('aceptar sólo desde INVITED; las pendientes de un usuario con quién invitó', async () => {
    const resultados = []
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: `Boda ${nombre}`, ownerId })
      const m = await invitar(repo, evento.id, 'Invitada')
      const pendientes = await repo.listarInvitacionesPendientes(m.userId)
      resultados.push(pendientes.map(({ membershipId: _m, eventId: _e, ...resto }) => resto))
      expect(await repo.aceptarInvitacion(evento.id, m.userId)).toBe(true)
      expect(await repo.aceptarInvitacion(evento.id, m.userId)).toBe(false)
      expect(await repo.listarInvitacionesPendientes(m.userId), nombre).toEqual([])
      expect(await repo.buscarMembresiaActiva(evento.id, m.userId), nombre).not.toBeNull()
    }
    expect(resultados[0]).toEqual([
      { eventName: 'Boda doble', role: 'PLANNER', invitedByName: 'Owner' },
    ])
    expect(resultados[1]).toEqual([
      { eventName: 'Boda prisma', role: 'PLANNER', invitedByName: 'Owner' },
    ])
  })

  it('un grant en la fila del creador se lee como owner con budgetView', async () => {
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      if (repo instanceof EventRepositoryEnMemoria) {
        const fila = repo.membresias.find((m) => m.eventId === evento.id && m.userId === ownerId)
        if (fila !== undefined) fila.budgetView = true
      } else {
        const m = await prisma.eventMembership.findUniqueOrThrow({
          where: { eventId_userId: { eventId: evento.id, userId: ownerId } },
        })
        await prisma.eventBudgetGrant.create({ data: { membershipId: m.id, grantedById: ownerId } })
      }
      // El dominio ya lo trata como `edit`: aquí sólo importa que ambos lo lean igual.
      expect(await repo.buscarMembresiaActiva(evento.id, ownerId), nombre).toEqual({
        role: 'COUPLE',
        owner: true,
        budgetView: true,
      })
    }
  })

  it('un grant sobre una membresía INVITED o REVOKED no abre el evento', async () => {
    for (const [nombre, repo] of sujetos()) {
      for (const status of ['INVITED', 'REVOKED'] as const) {
        const evento = await repo.crearConMembresia({ name: `Boda ${status}`, ownerId })
        const m = await invitar(repo, evento.id, `Grant-${status}`)
        if (repo instanceof EventRepositoryEnMemoria) {
          const fila = repo.membresias.find((x) => x.id === m.membershipId)
          if (fila !== undefined) Object.assign(fila, { status, budgetView: true })
        } else {
          await prisma.eventMembership.update({ where: { id: m.membershipId }, data: { status } })
          await prisma.eventBudgetGrant.create({
            data: { membershipId: m.membershipId, grantedById: ownerId },
          })
        }
        expect(await repo.buscarMembresiaActiva(evento.id, m.userId), nombre).toBeNull()
        expect(await repo.listarAccesiblesPor(m.userId), nombre).toEqual([])
      }
    }
  })

  it('el acceso sólo por contratación BOOKED entra en el listado sin budgetView', async () => {
    const categoria = await categoriaId(prisma)
    for (const [nombre, repo] of sujetos()) {
      const vendor = await prisma.user.create({
        data: {
          email: `vendor-${randomUUID()}@paridad.test`,
          passwordHash: 'x',
          fullName: 'Vendor',
        },
      })
      const borrador = await repo.crearConMembresia({ name: `Borrador ${nombre}`, ownerId })
      const creado = await repo.crearConMembresia({
        name: `Contratado ${nombre}`,
        ownerId,
        weddingDate: new Date('2027-06-12T00:00:00Z'),
        totalBudget: '100.00',
        venue: VENUE,
      })
      const activo = await repo.publicarSiCompleto(creado.id)
      expect(activo?.status, nombre).toBe('ACTIVE')
      if (repo instanceof EventRepositoryEnMemoria) {
        repo.perfiles.push({ id: `perfil-${nombre}`, userId: vendor.id })
        for (const eventId of [creado.id, borrador.id]) {
          repo.eventVendors.push({
            id: `ev-${eventId}`,
            eventId,
            vendorProfileId: `perfil-${nombre}`,
            status: 'BOOKED',
          })
        }
      } else {
        const perfil = await prisma.vendorProfile.create({
          data: { userId: vendor.id, businessName: 'Vendor', categoryId: categoria },
        })
        for (const eventId of [creado.id, borrador.id]) {
          await prisma.eventVendor.create({
            data: { eventId, vendorProfileId: perfil.id, categoryId: categoria, status: 'BOOKED' },
          })
        }
      }
      // Sin membresía: el borrador no se enseña a proveedores.
      expect(await repo.buscarMembresiaActiva(creado.id, vendor.id), nombre).toBeNull()
      const lista = await repo.listarAccesiblesPor(vendor.id)
      expect(
        lista.map((a) => ({ evento: a.evento.id, budgetView: a.budgetView })),
        nombre,
      ).toEqual([{ evento: creado.id, budgetView: false }])
    }
  })

  it('actualizarMembresia y revocarMembresia sobre una membresía ACTIVE', async () => {
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const m = await invitar(repo, evento.id, 'Activa')
      expect(await repo.aceptarInvitacion(evento.id, m.userId)).toBe(true)
      expect(
        await repo.actualizarMembresia(
          evento.id,
          m.membershipId,
          { role: 'COUPLE', budgetView: true },
          ownerId,
        ),
        nombre,
      ).toBe(true)
      expect(await repo.buscarMembresiaActiva(evento.id, m.userId), nombre).toEqual({
        role: 'COUPLE',
        owner: false,
        budgetView: true,
      })
      expect(
        await repo.revocarMembresia(evento.id, m.membershipId, ownerId, 'revoked'),
        nombre,
      ).toBe(true)
      expect(await repo.buscarMembresiaActiva(evento.id, m.userId), nombre).toBeNull()
      expect(await repo.buscarMembresiaPorId(evento.id, m.membershipId), nombre).toMatchObject({
        status: 'REVOKED',
        budgetView: false,
      })
    }
  })

  it('el AuditLog de invitar, aceptar, actualizar, revocar y rechazar coincide', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const ana = await invitar(repo, evento.id, 'Ana')
      const pia = await invitar(repo, evento.id, 'Pia')
      await repo.aceptarInvitacion(evento.id, ana.userId)
      await repo.actualizarMembresia(evento.id, ana.membershipId, { budgetView: true }, ownerId)
      await repo.revocarMembresia(evento.id, ana.membershipId, ownerId, 'revoked')
      await repo.revocarMembresia(evento.id, pia.membershipId, pia.userId, 'declined')

      // Los ids cambian entre sujetos: se comparan por quién son.
      const etiquetas = new Map<string, string>([
        [ownerId, 'owner'],
        [ana.userId, 'ana'],
        [pia.userId, 'pia'],
        [ana.membershipId, 'm-ana'],
        [pia.membershipId, 'm-pia'],
      ])
      const etiqueta = (id: string | null) => (id === null ? null : (etiquetas.get(id) ?? id))
      const filas =
        repo instanceof EventRepositoryEnMemoria
          ? repo.auditoria.filter((a) => a.eventId === evento.id)
          : await prisma.auditLog.findMany({ where: { eventId: evento.id } })
      resultados.push(
        filas
          .map((a) => {
            const [tipo, id] = a.target.split(':') as [string, string]
            return `${a.action} ${etiqueta(a.actorUserId)} ${tipo}:${etiqueta(id)}`
          })
          // `createdAt` puede empatar en el mismo milisegundo: se compara el conjunto.
          .sort(),
      )
    }
    expect(resultados[0]).toEqual(
      [
        'event.member.invited owner user:ana',
        'event.member.invited owner user:pia',
        'event.member.accepted ana user:ana',
        'event.member.updated owner membership:m-ana',
        'event.member.revoked owner membership:m-ana',
        'event.member.declined pia membership:m-pia',
      ].sort(),
    )
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('las pendientes van por updatedAt desc y, si empatan, por id asc', async () => {
    const RECIENTE = new Date('2026-10-14T10:00:00.000Z')
    const ANTIGUA = new Date('2026-10-14T09:00:00.000Z')
    const resultados = []
    for (const [nombre, repo] of sujetos()) {
      const invitada = await prisma.user.create({
        data: {
          email: `pendientes-${randomUUID()}@paridad.test`,
          passwordHash: 'x',
          fullName: 'Pendientes',
        },
      })
      const ids: string[] = []
      for (const evento of ['A', 'B', 'C']) {
        const { id } = await repo.crearConMembresia({ name: `${evento} ${nombre}`, ownerId })
        ids.push(
          (
            await repo.invitarMiembro({
              eventId: id,
              userId: invitada.id,
              role: 'PLANNER',
              invitedById: ownerId,
            })
          ).id,
        )
      }
      // A antigua; B y C empatan en la más reciente. Fijado a mano en los dos:
      // dos escrituras seguidas en Postgres pueden compartir milisegundo, y en
      // el doble el reloj nunca empata solo.
      const [a, b, c] = ids as [string, string, string]
      if (repo instanceof EventRepositoryEnMemoria) {
        // Ids del doble invertidos respecto al orden de inserción: un `sort`
        // estable que ignorase el `id` dejaría C delante de B.
        const fila = (id: string) => repo.membresias.find((m) => m.id === id)
        Object.assign(fila(a) ?? {}, { actualizadaEn: 1, id: 'm-3' })
        Object.assign(fila(b) ?? {}, { actualizadaEn: 2, id: 'm-2' })
        Object.assign(fila(c) ?? {}, { actualizadaEn: 2, id: 'm-1' })
      } else {
        await prisma.eventMembership.update({ where: { id: a }, data: { updatedAt: ANTIGUA } })
        await prisma.eventMembership.updateMany({
          where: { id: { in: [b, c] } },
          data: { updatedAt: RECIENTE },
        })
      }
      const pendientes = await repo.listarInvitacionesPendientes(invitada.id)
      const empatadas = pendientes.slice(0, 2).map((p) => p.membershipId)
      expect(empatadas, nombre).toEqual([...empatadas].sort((x, y) => (x < y ? -1 : 1)))
      resultados.push(pendientes.map((p) => p.eventName.split(' ')[0]).at(-1))
    }
    expect(resultados).toEqual(['A', 'A'])
  })

  it('actualizarMembresia sin cambios comprueba que esté viva y no audita', async () => {
    for (const [nombre, repo] of sujetos()) {
      const evento = await repo.crearConMembresia({ name: 'Boda', ownerId })
      const viva = await invitar(repo, evento.id, 'SinCambios')
      const revocada = await invitar(repo, evento.id, 'Revocada')
      await repo.revocarMembresia(evento.id, revocada.membershipId, ownerId, 'revoked')
      const auditadas = async () =>
        repo instanceof EventRepositoryEnMemoria
          ? repo.auditoria.filter((a) => a.eventId === evento.id).length
          : await prisma.auditLog.count({ where: { eventId: evento.id } })
      const antes = await auditadas()

      expect(
        await repo.actualizarMembresia(evento.id, viva.membershipId, {}, ownerId),
        nombre,
      ).toBe(true)
      expect(
        await repo.actualizarMembresia(evento.id, revocada.membershipId, {}, ownerId),
        nombre,
      ).toBe(false)
      expect(await auditadas(), nombre).toBe(antes)
    }
  })
})

import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'
import { limpiarContadoresDeRitmo } from '../support/throttler'

interface Usuario {
  id: string
  email: string
  accessToken: string
}

/**
 * e2e de la gestión de miembros (sólo el creador) y del flujo del invitado:
 * ver sus invitaciones pendientes, aceptar y rechazar.
 */
describe('Miembros e invitaciones e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: Usuario
  let luis: Usuario
  let pia: Usuario
  let extrano: Usuario
  let evento: string

  async function registrarYEntrar(email: string, fullName: string): Promise<Usuario> {
    const registro = await request(url)
      .post('/auth/register')
      .send({ email, password: 'una-contraseña-larga', fullName })
      .expect(201)

    await prisma.user.update({
      where: { email },
      data: { emailVerifiedAt: new Date() },
    })

    const login = await request(url)
      .post('/auth/login')
      .send({ email, password: 'una-contraseña-larga' })
      .expect(200)

    return {
      id: (registro.body as { id: string }).id,
      email,
      accessToken: (login.body as { accessToken: string }).accessToken,
    }
  }

  const auth = (u: { accessToken: string }): { Authorization: string } => ({
    Authorization: `Bearer ${u.accessToken}`,
  })

  async function invitar(email: string, role: 'COUPLE' | 'PLANNER'): Promise<string> {
    const r = await request(url)
      .post(`/events/${evento}/members`)
      .set(auth(ana))
      .send({ email, role })
      .expect(201)
    return (r.body as { id: string }).id
  }

  async function aceptar(u: { accessToken: string }): Promise<void> {
    await request(url).post(`/events/${evento}/invitation/accept`).set(auth(u)).expect(200)
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    luis = await registrarYEntrar('luis@test.com', 'Luis')
    pia = await registrarYEntrar('pia@test.com', 'Pia')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')

    evento = await crearEventoPublicado(url, ana.accessToken, 'Boda de Ana')
  }, 180_000)

  // El limitador `invite` (20/h por IP) es de toda la ruta: sin limpiar, las
  // invitaciones de los tests anteriores se sumarían a las del siguiente.
  beforeEach(async () => {
    await limpiarContadoresDeRitmo(redis.getConnectionUrl())
  })

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('invitar → aparece en /me/invitations → aceptar → entra al evento', async () => {
    await invitar('luis@test.com', 'COUPLE')
    const pendientes = await request(url).get('/me/invitations').set(auth(luis)).expect(200)
    expect((pendientes.body as { items: unknown[] }).items).toEqual([
      expect.objectContaining({
        eventId: evento,
        eventName: 'Boda de Ana',
        role: 'COUPLE',
        invitedByName: 'Ana',
      }),
    ])
    await request(url).get(`/events/${evento}`).set(auth(luis)).expect(404)

    const r = await request(url)
      .post(`/events/${evento}/invitation/accept`)
      .set(auth(luis))
      .expect(200)
    expect(r.body).toEqual({ eventId: evento, status: 'ACTIVE' })
    const ev = await request(url).get(`/events/${evento}`).set(auth(luis)).expect(200)
    expect(ev.body).toMatchObject({ budgetAccess: 'none', totalBudget: null })
    // Aceptar dos veces: la segunda no encuentra invitación.
    await request(url).post(`/events/${evento}/invitation/accept`).set(auth(luis)).expect(404)
  })

  it('rechazar: desaparece de pendientes y no da acceso', async () => {
    await invitar('pia@test.com', 'PLANNER')
    await request(url).post(`/events/${evento}/invitation/decline`).set(auth(pia)).expect(204)
    const pendientes = await request(url).get('/me/invitations').set(auth(pia)).expect(200)
    expect((pendientes.body as { items: unknown[] }).items).toEqual([])
    await request(url).get(`/events/${evento}`).set(auth(pia)).expect(404)
  })

  it('aceptar o rechazar sin invitación es 404, también en un evento inexistente', async () => {
    await request(url).post(`/events/${evento}/invitation/accept`).set(auth(extrano)).expect(404)
    await request(url)
      .post(`/events/${randomUUID()}/invitation/decline`)
      .set(auth(extrano))
      .expect(404)
  })

  it('un id que no es UUID es 404, no 400 ni 500', async () => {
    const borrado = await request(url)
      .delete(`/events/${evento}/members/no-es-uuid`)
      .set(auth(ana))
      .expect(404)
    expect((borrado.body as { code: string }).code).toBe('MEMBER_NOT_FOUND')
    const editado = await request(url)
      .patch(`/events/${evento}/members/no-es-uuid`)
      .set(auth(ana))
      .send({ budgetAccess: 'view' })
      .expect(404)
    expect((editado.body as { code: string }).code).toBe('MEMBER_NOT_FOUND')
    const aceptado = await request(url)
      .post('/events/no-es-uuid/invitation/accept')
      .set(auth(extrano))
      .expect(404)
    expect((aceptado.body as { code: string }).code).toBe('NO_PENDING_INVITATION')
    const rechazado = await request(url)
      .post('/events/no-es-uuid/invitation/decline')
      .set(auth(extrano))
      .expect(404)
    expect((rechazado.body as { code: string }).code).toBe('NO_PENDING_INVITATION')
  })

  it('la creadora lista, concede ver, cambia el rol y revoca', async () => {
    const u = await registrarYEntrar(`m-${randomUUID()}@test.com`, 'Marta')
    const id = await invitar(u.email, 'PLANNER')
    await aceptar(u)

    const lista = await request(url).get(`/events/${evento}/members`).set(auth(ana)).expect(200)
    const items = (
      lista.body as { items: Array<{ id: string; owner: boolean; budgetAccess: string }> }
    ).items
    expect(items[0]).toMatchObject({ owner: true, budgetAccess: 'edit', fullName: 'Ana' })
    expect(items.find((m) => m.id === id)).toMatchObject({
      budgetAccess: 'none',
      status: 'ACTIVE',
      role: 'PLANNER',
    })

    const concedido = await request(url)
      .patch(`/events/${evento}/members/${id}`)
      .set(auth(ana))
      .send({ budgetAccess: 'view' })
      .expect(200)
    expect(concedido.body).toMatchObject({ id, budgetAccess: 'view' })
    await request(url).get(`/events/${evento}/budget-summary`).set(auth(u)).expect(200)

    const rol = await request(url)
      .patch(`/events/${evento}/members/${id}`)
      .set(auth(ana))
      .send({ role: 'COUPLE' })
      .expect(200)
    expect(rol.body).toMatchObject({ role: 'COUPLE', budgetAccess: 'view' })

    await request(url).delete(`/events/${evento}/members/${id}`).set(auth(ana)).expect(204)
    await request(url).get(`/events/${evento}`).set(auth(u)).expect(404)
    await request(url).delete(`/events/${evento}/members/${id}`).set(auth(ana)).expect(404)

    // Reinvitada: nace sin grant.
    await invitar(u.email, 'PLANNER')
    await aceptar(u)
    const ev = await request(url).get(`/events/${evento}`).set(auth(u)).expect(200)
    expect(ev.body).toMatchObject({ budgetAccess: 'none' })
  })

  it('cancelar una invitación pendiente la quita de las del invitado', async () => {
    const u = await registrarYEntrar(`c-${randomUUID()}@test.com`, 'Cancelada')
    const id = await invitar(u.email, 'PLANNER')
    await request(url).delete(`/events/${evento}/members/${id}`).set(auth(ana)).expect(204)
    const pendientes = await request(url).get('/me/invitations').set(auth(u)).expect(200)
    expect((pendientes.body as { items: unknown[] }).items).toEqual([])
  })

  it('la creadora no puede tocarse a sí misma: 422', async () => {
    const lista = await request(url).get(`/events/${evento}/members`).set(auth(ana)).expect(200)
    const propia = (lista.body as { items: Array<{ id: string; owner: boolean }> }).items.find(
      (m) => m.owner,
    )
    await request(url).delete(`/events/${evento}/members/${propia?.id}`).set(auth(ana)).expect(422)
    await request(url)
      .patch(`/events/${evento}/members/${propia?.id}`)
      .set(auth(ana))
      .send({ budgetAccess: 'none' })
      .expect(422)
    const ev = await request(url).get(`/events/${evento}`).set(auth(ana)).expect(200)
    expect(ev.body).toMatchObject({ budgetAccess: 'edit' })
  })

  it('sólo la creadora gestiona: un COUPLE y un PLANNER activos reciben 403, un extraño 404', async () => {
    const pareja = await registrarYEntrar(`p-${randomUUID()}@test.com`, 'Pareja')
    const planner = await registrarYEntrar(`pl-${randomUUID()}@test.com`, 'Planner')
    const idPlanner = await invitar(planner.email, 'PLANNER')
    await invitar(pareja.email, 'COUPLE')
    await aceptar(pareja)
    await aceptar(planner)

    for (const [u, esperado] of [
      [pareja, 403],
      [planner, 403],
      [extrano, 404],
    ] as const) {
      await request(url).get(`/events/${evento}/members`).set(auth(u)).expect(esperado)
      await request(url)
        .post(`/events/${evento}/members`)
        .set(auth(u))
        .send({ email: 'x@test.com', role: 'PLANNER' })
        .expect(esperado)
      await request(url)
        .patch(`/events/${evento}/members/${idPlanner}`)
        .set(auth(u))
        .send({ budgetAccess: 'view' })
        .expect(esperado)
      await request(url)
        .delete(`/events/${evento}/members/${idPlanner}`)
        .set(auth(u))
        .expect(esperado)
    }
  })

  it('una membresía de otro evento es 404 aunque la pida su creadora', async () => {
    const otro = await crearEventoPublicado(url, ana.accessToken, 'Otra boda')
    const u = await registrarYEntrar(`o-${randomUUID()}@test.com`, 'Otro')
    const id = await invitar(u.email, 'PLANNER')
    await request(url).delete(`/events/${otro}/members/${id}`).set(auth(ana)).expect(404)
  })

  it('invitar tiene límite propio: 20 por hora desde la misma IP; la 21 es 429', async () => {
    // Los invitados nunca entran: basta con que la cuenta exista.
    const invitados = []
    for (let i = 0; i < 21; i += 1) {
      invitados.push(
        await prisma.user.create({
          data: {
            email: `lim-${i}-${randomUUID()}@test.com`,
            passwordHash: 'x',
            fullName: `Lim ${i}`,
          },
        }),
      )
    }
    for (const u of invitados.slice(0, 20)) await invitar(u.email, 'PLANNER')

    const ultimo = invitados[20]
    await request(url)
      .post(`/events/${evento}/members`)
      .set(auth(ana))
      .send({ email: ultimo?.email, role: 'PLANNER' })
      .expect(429)
  })

  describe('aviso al dueño en /me/notifications', () => {
    interface CuerpoMias {
      items: Array<{ type: string; payload: unknown; event: { id: string } }>
      unreadCount: number
    }

    /** Las `event.member.responded` de `u` en un evento, tal como las ve su campana. */
    async function respuestasVistasPor(
      u: { accessToken: string },
      eventId: string,
    ): Promise<CuerpoMias['items']> {
      const r = await request(url).get('/me/notifications?limit=100').set(auth(u)).expect(200)
      return (r.body as CuerpoMias).items.filter(
        (n) => n.type === 'event.member.responded' && n.event.id === eventId,
      )
    }

    /** Evento nuevo de `ana` con un PLANNER y un segundo COUPLE ACTIVE y un invitado pendiente. */
    async function escenario() {
      const eventoNuevo = await crearEventoPublicado(url, ana.accessToken, 'Boda con equipo')
      const invitarAlNuevo = async (u: Usuario, role = 'PLANNER'): Promise<void> => {
        await request(url)
          .post(`/events/${eventoNuevo}/members`)
          .set(auth(ana))
          .send({ email: u.email, role })
          .expect(201)
      }
      const planner = await registrarYEntrar(`planner-${randomUUID()}@test.com`, 'Planner')
      await invitarAlNuevo(planner)
      await request(url)
        .post(`/events/${eventoNuevo}/invitation/accept`)
        .set(auth(planner))
        .expect(200)
      const pareja = await registrarYEntrar(`pareja-${randomUUID()}@test.com`, 'Pareja')
      await invitarAlNuevo(pareja, 'COUPLE')
      await request(url)
        .post(`/events/${eventoNuevo}/invitation/accept`)
        .set(auth(pareja))
        .expect(200)
      const invitado = await registrarYEntrar(`invitado-${randomUUID()}@test.com`, 'Invitada')
      await invitarAlNuevo(invitado)
      return { eventoNuevo, planner, pareja, invitado }
    }

    it('al aceptar, el dueño ve event.member.responded en /me/notifications y el planner no', async () => {
      const { eventoNuevo, planner, pareja, invitado } = await escenario()

      await request(url)
        .post(`/events/${eventoNuevo}/invitation/accept`)
        .set(auth(invitado))
        .expect(200)

      // El dueño ve también la del planner que entró antes: se busca la de la invitada.
      const delDueno = await respuestasVistasPor(ana, eventoNuevo)
      expect(delDueno).toContainEqual(
        expect.objectContaining({
          payload: { userId: invitado.id, fullName: 'Invitada', response: 'ACCEPTED' },
        }),
      )
      expect(await respuestasVistasPor(planner, eventoNuevo)).toEqual([])
      // Ni un segundo COUPLE: la vista de destino exige ser el dueño.
      expect(await respuestasVistasPor(pareja, eventoNuevo)).toEqual([])
      expect(await respuestasVistasPor(invitado, eventoNuevo)).toEqual([])
    })

    it('al rechazar, el dueño ve DECLINED y quien rechaza no ve nada', async () => {
      const { eventoNuevo, planner, pareja, invitado } = await escenario()

      await request(url)
        .post(`/events/${eventoNuevo}/invitation/decline`)
        .set(auth(invitado))
        .expect(204)

      expect(await respuestasVistasPor(ana, eventoNuevo)).toContainEqual(
        expect.objectContaining({
          payload: { userId: invitado.id, fullName: 'Invitada', response: 'DECLINED' },
        }),
      )
      expect(await respuestasVistasPor(planner, eventoNuevo)).toEqual([])
      // Ni un segundo COUPLE: la vista de destino exige ser el dueño.
      expect(await respuestasVistasPor(pareja, eventoNuevo)).toEqual([])
      expect(await respuestasVistasPor(invitado, eventoNuevo)).toEqual([])
    })
  })
})

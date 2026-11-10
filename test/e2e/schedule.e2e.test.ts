import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { categoriaId } from '../support/categorias'
import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'

/**
 * Mismo arranque que `event-vendors.e2e.test.ts`: prueba contra el servidor
 * real, no una llamada directa a los casos de uso, porque lo que se quiere
 * comprobar es que `@RequireEventAccess` y `EventAccessGuard` están
 * realmente enganchados en estas rutas.
 */
describe('Cronograma del evento e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let evento: string

  async function registrarYEntrar(
    email: string,
    fullName: string,
  ): Promise<{ id: string; accessToken: string }> {
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
      accessToken: (login.body as { accessToken: string }).accessToken,
    }
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')

    evento = await crearEventoPublicado(url, ana.accessToken, 'Boda de Ana')
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('CRUD del cronograma con estado', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    const creado = await request(url)
      .post(`/events/${evento}/schedule`)
      .set(auth)
      .send({
        title: 'Inicio de la fiesta',
        startsAt: '2027-06-12T22:00:00-05:00',
        location: { name: 'Salón', address: 'Cra 7 #1', lat: 4.6, lng: -74.07 },
      })
      .expect(201)
    const id = (creado.body as { id: string }).id
    expect(creado.body).toMatchObject({ status: 'PENDING', startsAt: '2027-06-13T03:00:00.000Z' })

    await request(url)
      .patch(`/events/${evento}/schedule/${id}`)
      .set(auth)
      .send({ status: 'DONE' })
      .expect(200)
    await request(url)
      .patch(`/events/${evento}/schedule/${id}`)
      .set(auth)
      .send({ endsAt: '2027-06-12T20:00:00-05:00' })
      .expect(422)

    const lista = await request(url).get(`/events/${evento}/schedule`).set(auth).expect(200)
    expect(lista.body).toHaveLength(1)

    await request(url).delete(`/events/${evento}/schedule/${id}`).set(auth).expect(204)
    await request(url).delete(`/events/${evento}/schedule/${id}`).set(auth).expect(404)
  })

  it('quien crea el evento es su PLANNER', async () => {
    const detalle = await request(url)
      .get(`/events/${evento}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    expect((detalle.body as { access: unknown }).access).toMatchObject({
      kind: 'member',
      role: 'PLANNER',
      owner: true,
    })
  })

  it('la pareja edita el cronograma pero no cambia el estado: eso es del planner', async () => {
    const pareja = await registrarYEntrar('pareja-schedule@test.com', 'Pareja')
    await prisma.eventMembership.create({
      data: { eventId: evento, userId: pareja.id, role: 'COUPLE', invitedById: ana.id },
    })
    const comoPareja = { Authorization: `Bearer ${pareja.accessToken}` }

    const creado = await request(url)
      .post(`/events/${evento}/schedule`)
      .set(comoPareja)
      .send({ title: 'Brindis', startsAt: '2027-06-12T23:00:00Z' })
      .expect(201)
    const id = (creado.body as { id: string }).id

    await request(url)
      .patch(`/events/${evento}/schedule/${id}`)
      .set(comoPareja)
      .send({ title: 'Brindis de los novios' })
      .expect(200)
    const prohibido = await request(url)
      .patch(`/events/${evento}/schedule/${id}`)
      .set(comoPareja)
      .send({ status: 'DONE' })
      .expect(403)
    expect(prohibido.body).toMatchObject({ code: 'SCHEDULE_STATUS_PLANNER_ONLY' })
    await request(url)
      .post(`/events/${evento}/schedule`)
      .set(comoPareja)
      .send({ title: 'Ya hecho', startsAt: '2027-06-12T23:00:00Z', status: 'DONE' })
      .expect(403)

    await request(url)
      .patch(`/events/${evento}/schedule/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ status: 'DONE' })
      .expect(200)

    await request(url).delete(`/events/${evento}/schedule/${id}`).set(comoPareja).expect(204)
  })

  it('POST con fin antes de inicio → 400; id no UUID → 404; extraño → 404', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    await request(url)
      .post(`/events/${evento}/schedule`)
      .set(auth)
      .send({ title: 'X', startsAt: '2027-06-12T22:00:00Z', endsAt: '2027-06-12T21:00:00Z' })
      .expect(400)
    await request(url)
      .patch(`/events/${evento}/schedule/no-uuid`)
      .set(auth)
      .send({ title: 'X' })
      .expect(404)
    await request(url)
      .get(`/events/${evento}/schedule`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)
  })

  it('un vendor BOOKED sobre un DRAFT recibe 404, no 403, en el cronograma', async () => {
    // Mismo motivo que `events-draft.e2e`: un 403 en vez de 404 delataría que
    // el borrador existe. `buscarContratacionReservada` sólo mira eventos
    // ACTIVE, así que un DRAFT tiene que dar 404 también en esta ruta.
    const fotografo = await registrarYEntrar('foto-schedule@test.com', 'Fotógrafo')
    const creado = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Boda con fotógrafo (schedule)' })
      .expect(201)
    const draft = (creado.body as { id: string }).id
    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: fotografo.id,
        businessName: 'Luz',
        categoryId: await categoriaId(prisma, 'photography'),
        status: 'PUBLISHED',
      },
    })
    await prisma.eventVendor.create({
      data: {
        eventId: draft,
        vendorProfileId: perfil.id,
        categoryId: await categoriaId(prisma, 'photography'),
        status: 'BOOKED',
      },
    })

    await request(url)
      .get(`/events/${draft}/schedule`)
      .set('Authorization', `Bearer ${fotografo.accessToken}`)
      .expect(404)
  })

  /**
   * Cableado de la Task 8: que cada ruta nueva está montada con su nivel de
   * acceso y responde con la forma del contrato. Los escenarios de producto
   * (carreras, recordatorios, recontratar) son de la Task 9.
   */
  it('rutas de proveedores: asignar, notas sólo del planner, confirmar, avisar y PDF', async () => {
    const comoAna = { Authorization: `Bearer ${ana.accessToken}` }
    const pareja = await registrarYEntrar('pareja-proveedores@test.com', 'Pareja P')
    await prisma.eventMembership.create({
      data: { eventId: evento, userId: pareja.id, role: 'COUPLE', invitedById: ana.id },
    })
    const comoPareja = { Authorization: `Bearer ${pareja.accessToken}` }
    const dj = await registrarYEntrar('dj-schedule@test.com', 'DJ')
    const comoDj = { Authorization: `Bearer ${dj.accessToken}` }
    const categoryId = await categoriaId(prisma, 'photography')
    const perfil = await prisma.vendorProfile.create({
      data: { userId: dj.id, businessName: 'Ritmo', categoryId, status: 'PUBLISHED' },
    })
    const contratacion = await prisma.eventVendor.create({
      data: { eventId: evento, vendorProfileId: perfil.id, categoryId, status: 'BOOKED' },
    })
    const { name: categoryName } = await prisma.vendorCategory.findUniqueOrThrow({
      where: { id: categoryId },
    })
    const base = `/events/${evento}/schedule`

    const asignables = await request(url).get(`${base}/assignable-vendors`).set(comoAna).expect(200)
    expect(asignables.body).toEqual([
      { eventVendorId: contratacion.id, name: 'Ritmo', categoryName },
    ])
    const soloPlanner = await request(url)
      .get(`${base}/assignable-vendors`)
      .set(comoPareja)
      .expect(403)
    expect(soloPlanner.body).toMatchObject({ code: 'SCHEDULE_PLANNER_ONLY' })

    const creado = await request(url)
      .post(base)
      .set(comoAna)
      .send({ title: 'Primer baile', startsAt: '2027-06-12T23:30:00Z', eventVendorIds: [] })
      .expect(201)
    const itemId = (creado.body as { id: string }).id
    expect(creado.body).not.toHaveProperty('noteCount')
    const asignado = await request(url)
      .put(`${base}/${itemId}/vendors`)
      .set(comoAna)
      .send({ eventVendorIds: [contratacion.id] })
      .expect(200)
    expect((asignado.body as { vendors: unknown }).vendors).toEqual([
      {
        eventVendorId: contratacion.id,
        name: 'Ritmo',
        categoryName,
        confirmed: false,
      },
    ])
    await request(url)
      .put(`${base}/${itemId}/vendors`)
      .set(comoAna)
      .send({ eventVendorIds: [contratacion.id, contratacion.id] })
      .expect(400)

    const nota = await request(url)
      .post(`${base}/${itemId}/notes`)
      .set(comoAna)
      .send({ body: '  Llevar el cable largo  ' })
      .expect(201)
    expect(nota.body).toMatchObject({
      itemId,
      body: 'Llevar el cable largo',
      author: { id: ana.id, name: 'Ana', avatarUrl: null },
    })
    const notas = await request(url).get(`${base}/${itemId}/notes`).set(comoAna).expect(200)
    expect(notas.body).toHaveLength(1)
    const listaPlanner = await request(url).get(base).set(comoAna).expect(200)
    expect(listaPlanner.body).toEqual([expect.objectContaining({ id: itemId, noteCount: 1 })])

    // La pareja: ni notas ni `noteCount`, y el 404 llega antes que el 400 del cuerpo.
    const listaPareja = await request(url).get(base).set(comoPareja).expect(200)
    expect(listaPareja.body).toHaveLength(1)
    expect(JSON.stringify(listaPareja.body)).not.toContain('noteCount')
    for (const peticion of [
      request(url).get(`${base}/${itemId}/notes`).set(comoPareja),
      request(url).post(`${base}/${itemId}/notes`).set(comoPareja).send({}),
    ]) {
      const respuesta = await peticion.expect(404)
      expect(respuesta.body).toMatchObject({ code: 'SCHEDULE_ITEM_NOT_FOUND' })
    }

    // Para el proveedor las notas tampoco existen: 404 del caso de uso, no 403 del guard.
    for (const peticion of [
      request(url).get(`${base}/${itemId}/notes`).set(comoDj),
      request(url).post(`${base}/${itemId}/notes`).set(comoDj).send({}),
    ]) {
      const respuesta = await peticion.expect(404)
      expect(respuesta.body).toMatchObject({ code: 'SCHEDULE_ITEM_NOT_FOUND' })
    }

    // El proveedor ve el cronograma y confirma lo que tenía delante.
    const listaDj = await request(url).get(base).set(comoDj).expect(200)
    expect(JSON.stringify(listaDj.body)).not.toContain('noteCount')
    const antes = await request(url).get(`${base}/confirmations`).set(comoDj).expect(200)
    expect(antes.body).toEqual({
      ready: 0,
      total: 1,
      vendors: [{ userId: dj.id, name: 'Ritmo', avatarUrl: null, ready: false }],
      mine: { pending: [{ itemId, startsAt: '2027-06-12T23:30:00.000Z', endsAt: null }] },
    })
    await request(url)
      .post(`${base}/confirmations`)
      .set(comoDj)
      .send({ items: [{ itemId: 'no-uuid', startsAt: '2027-06-12T23:30:00Z', endsAt: null }] })
      .expect(400)
    await request(url).post(`${base}/confirmations`).set(comoAna).send({ items: [] }).expect(403)
    const despues = await request(url)
      .post(`${base}/confirmations`)
      .set(comoDj)
      .send({ items: (antes.body as { mine: { pending: unknown[] } }).mine.pending })
      .expect(200)
    expect(despues.body).toMatchObject({ ready: 1, total: 1, mine: { pending: [] } })
    const vistaPlanner = await request(url).get(`${base}/confirmations`).set(comoAna).expect(200)
    expect(vistaPlanner.body).toMatchObject({ ready: 1, total: 1, mine: null })

    await request(url).post(`${base}/notify-vendors`).set(comoDj).expect(403)
    const avisoPareja = await request(url)
      .post(`${base}/notify-vendors`)
      .set(comoPareja)
      .expect(403)
    expect(avisoPareja.body).toMatchObject({ code: 'SCHEDULE_PLANNER_ONLY' })
    const aviso = await request(url).post(`${base}/notify-vendors`).set(comoAna).expect(200)
    expect(aviso.body).toEqual({ notified: 0 })

    const pdf = await request(url).get(`${base}/pdf`).set(comoPareja).expect(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.headers['content-disposition']).toMatch(
      /^attachment; filename="timeline-\d{4}-\d{2}-\d{2}\.pdf"$/,
    )

    await request(url).delete(`${base}/${itemId}`).set(comoAna).expect(204)
  })
})

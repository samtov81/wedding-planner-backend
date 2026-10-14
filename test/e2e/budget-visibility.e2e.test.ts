import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { categoriaId } from '../support/categorias'
import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'

/**
 * e2e de la privacidad del presupuesto: la creadora (y el admin) tiene
 * `BUDGET_VIEW`/`BUDGET_EDIT`; un miembro sólo lee si la creadora le concede el
 * grant `view`, y nunca escribe. Quien está en el evento sin permiso recibe
 * 403; quien no está, 404.
 */
type Usuario = { id: string; email: string; accessToken: string }

describe('Visibilidad del presupuesto e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: Usuario
  let luis: Usuario
  let pia: Usuario
  let dj: Usuario
  let extrano: Usuario
  let lia: Usuario
  let teo: Usuario
  let evento: string
  const membresias = new Map<string, string>()

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

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    luis = await registrarYEntrar('luis@test.com', 'Luis')
    pia = await registrarYEntrar('pia@test.com', 'Pia')
    dj = await registrarYEntrar('dj@test.com', 'DJ')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')
    lia = await registrarYEntrar('lia@test.com', 'Lia')
    teo = await registrarYEntrar('teo@test.com', 'Teo')

    evento = await crearEventoPublicado(url, ana.accessToken, 'Boda de Ana')

    // Flujo real: la creadora invita y cada invitado acepta. Lia (COUPLE) y Teo
    // (PLANNER) reciben además el grant de presupuesto; Luis y Pia no.
    for (const [u, role] of [
      [luis, 'COUPLE'],
      [pia, 'PLANNER'],
      [lia, 'COUPLE'],
      [teo, 'PLANNER'],
    ] as const) {
      const r = await request(url)
        .post(`/events/${evento}/members`)
        .set({ Authorization: `Bearer ${ana.accessToken}` })
        .send({ email: u.email, role })
        .expect(201)
      membresias.set(u.id, (r.body as { id: string }).id)
      await request(url)
        .post(`/events/${evento}/invitation/accept`)
        .set({ Authorization: `Bearer ${u.accessToken}` })
        .expect(200)
    }
    for (const u of [lia, teo]) {
      await request(url)
        .patch(`/events/${evento}/members/${membresias.get(u.id)}`)
        .set({ Authorization: `Bearer ${ana.accessToken}` })
        .send({ budgetAccess: 'view' })
        .expect(200)
    }

    const categoria = await categoriaId(prisma, 'music-entertainment')
    const perfil = await prisma.vendorProfile.create({
      data: { userId: dj.id, businessName: 'DJ Max', categoryId: categoria, status: 'PUBLISHED' },
    })
    await prisma.eventVendor.create({
      data: {
        eventId: evento,
        vendorProfileId: perfil.id,
        categoryId: categoria,
        status: 'BOOKED',
        assignedBudget: '500.00',
      },
    })

    // La creadora fija el total del evento.
    await request(url)
      .patch(`/events/${evento}`)
      .set({ Authorization: `Bearer ${ana.accessToken}` })
      .send({ totalBudget: '30000' })
      .expect(200)
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('la creadora lista gastos, ve el resumen y crea/edita/borra', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    await request(url).get(`/events/${evento}/expenses`).set(auth).expect(200)
    await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(200)
    const creado = await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'Flores', category: 'Flowers', amount: '100', payeeName: 'Floristería' })
      .expect(201)
    const id = (creado.body as { id: string }).id
    await request(url)
      .patch(`/events/${evento}/expenses/${id}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(200)
    await request(url).delete(`/events/${evento}/expenses/${id}`).set(auth).expect(204)
  })

  async function crearGastoDeAna(): Promise<string> {
    const creado = await request(url)
      .post(`/events/${evento}/expenses`)
      .set({ Authorization: `Bearer ${ana.accessToken}` })
      .send({ concept: 'Ajeno', category: 'Flowers', amount: '10', payeeName: 'Proveedor' })
      .expect(201)
    return (creado.body as { id: string }).id
  }

  it.each([
    ['COUPLE sin permiso', () => luis],
    ['PLANNER sin permiso', () => pia],
    ['proveedor contratado', () => dj],
  ])('%s recibe 403 en lectura y escritura de gastos', async (_quien, usuario) => {
    const gasto = await crearGastoDeAna()
    const auth = { Authorization: `Bearer ${usuario().accessToken}` }
    await request(url).get(`/events/${evento}/expenses`).set(auth).expect(403)
    await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(403)
    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'X', category: 'Y', amount: '1', payeeName: 'Z' })
      .expect(403)
    await request(url)
      .patch(`/events/${evento}/expenses/${gasto}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(403)
    await request(url).delete(`/events/${evento}/expenses/${gasto}`).set(auth).expect(403)

    // Nada de lo anterior tocó los datos: el gasto sigue ahí, pendiente, y el POST no creó otro.
    const lista = await request(url)
      .get(`/events/${evento}/expenses`)
      .set({ Authorization: `Bearer ${ana.accessToken}` })
      .expect(200)
    const items = (lista.body as { items: { id: string; concept: string; status: string }[] }).items
    expect(items.find((g) => g.id === gasto)?.status).toBe('PENDING')
    expect(items.filter((g) => g.concept === 'X')).toHaveLength(0)
  })

  it('un usuario sin acceso al evento recibe 404 en las cinco rutas de gastos', async () => {
    const gasto = await crearGastoDeAna()
    const auth = { Authorization: `Bearer ${extrano.accessToken}` }
    await request(url).get(`/events/${evento}/expenses`).set(auth).expect(404)
    await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(404)
    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'X', category: 'Y', amount: '1', payeeName: 'Z' })
      .expect(404)
    await request(url)
      .patch(`/events/${evento}/expenses/${gasto}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(404)
    await request(url).delete(`/events/${evento}/expenses/${gasto}`).set(auth).expect(404)
  })

  it('la creadora ve total, asignado y budgetAccess edit', async () => {
    const auth = { Authorization: `Bearer ${ana.accessToken}` }
    const ev = await request(url).get(`/events/${evento}`).set(auth).expect(200)
    expect(ev.body).toMatchObject({ totalBudget: '30000.00', budgetAccess: 'edit' })
    const lista = await request(url).get('/events').set(auth).expect(200)
    expect(
      (lista.body as Array<{ id: string; totalBudget: string | null }>).find((e) => e.id === evento)
        ?.totalBudget,
    ).toBe('30000.00')
    const vendors = await request(url).get(`/events/${evento}/vendors`).set(auth).expect(200)
    expect((vendors.body as Array<{ assignedBudget: string | null }>)[0]?.assignedBudget).toBe(
      '500.00',
    )
  })

  it.each([
    ['COUPLE sin permiso', () => luis],
    ['PLANNER sin permiso', () => pia],
  ])('%s no ve importes y recibe budgetAccess none', async (_quien, usuario) => {
    const auth = { Authorization: `Bearer ${usuario().accessToken}` }
    const ev = await request(url).get(`/events/${evento}`).set(auth).expect(200)
    expect(ev.body).toMatchObject({ totalBudget: null, budgetAccess: 'none' })
    const lista = await request(url).get('/events').set(auth).expect(200)
    expect(
      (lista.body as Array<{ id: string; totalBudget: string | null }>).find((e) => e.id === evento)
        ?.totalBudget,
    ).toBeNull()
    const vendors = await request(url).get(`/events/${evento}/vendors`).set(auth).expect(200)
    const filas = vendors.body as Array<{ assignedBudget: string | null }>
    expect(filas.length).toBeGreaterThan(0)
    for (const v of filas) expect(v.assignedBudget).toBeNull()
  })

  it('el proveedor contratado no ve el total', async () => {
    const ev = await request(url)
      .get(`/events/${evento}`)
      .set({ Authorization: `Bearer ${dj.accessToken}` })
      .expect(200)
    expect(ev.body).toMatchObject({ totalBudget: null, budgetAccess: 'none' })
  })

  it.each([
    ['COUPLE no creador con permiso', () => lia],
    ['PLANNER con permiso', () => teo],
  ])('%s lee gastos, resumen e importes, y recibe 403 al escribir', async (_quien, usuario) => {
    const gasto = await crearGastoDeAna()
    const auth = { Authorization: `Bearer ${usuario().accessToken}` }
    await request(url).get(`/events/${evento}/expenses`).set(auth).expect(200)
    await request(url).get(`/events/${evento}/budget-summary`).set(auth).expect(200)
    await request(url)
      .post(`/events/${evento}/expenses`)
      .set(auth)
      .send({ concept: 'X', category: 'Y', amount: '1', payeeName: 'Z' })
      .expect(403)
    await request(url)
      .patch(`/events/${evento}/expenses/${gasto}`)
      .set(auth)
      .send({ status: 'PAID' })
      .expect(403)
    await request(url).delete(`/events/${evento}/expenses/${gasto}`).set(auth).expect(403)

    const ev = await request(url).get(`/events/${evento}`).set(auth).expect(200)
    expect(ev.body).toMatchObject({ totalBudget: '30000.00', budgetAccess: 'view' })
    const lista = await request(url).get('/events').set(auth).expect(200)
    expect(
      (lista.body as Array<{ id: string; totalBudget: string | null }>).find((e) => e.id === evento)
        ?.totalBudget,
    ).toBe('30000.00')
    const vendors = await request(url).get(`/events/${evento}/vendors`).set(auth).expect(200)
    expect((vendors.body as Array<{ assignedBudget: string | null }>)[0]?.assignedBudget).toBe(
      '500.00',
    )
  })

  it('retirar el permiso corta la lectura en la siguiente petición', async () => {
    const u = await registrarYEntrar(`r-${randomUUID()}@test.com`, 'Retirada')
    const r = await request(url)
      .post(`/events/${evento}/members`)
      .set({ Authorization: `Bearer ${ana.accessToken}` })
      .send({ email: u.email, role: 'PLANNER' })
      .expect(201)
    const id = (r.body as { id: string }).id
    await request(url)
      .post(`/events/${evento}/invitation/accept`)
      .set({ Authorization: `Bearer ${u.accessToken}` })
      .expect(200)
    const patch = (budgetAccess: 'view' | 'none') =>
      request(url)
        .patch(`/events/${evento}/members/${id}`)
        .set({ Authorization: `Bearer ${ana.accessToken}` })
        .send({ budgetAccess })
        .expect(200)

    await patch('view')
    await request(url)
      .get(`/events/${evento}/budget-summary`)
      .set({ Authorization: `Bearer ${u.accessToken}` })
      .expect(200)
    await patch('none')
    await request(url)
      .get(`/events/${evento}/budget-summary`)
      .set({ Authorization: `Bearer ${u.accessToken}` })
      .expect(403)
  })

  it('el extraño no ve el evento ni con un grant ajeno en la base', async () => {
    await request(url)
      .get(`/events/${evento}`)
      .set({ Authorization: `Bearer ${extrano.accessToken}` })
      .expect(404)
    const lista = await request(url)
      .get('/events')
      .set({ Authorization: `Bearer ${extrano.accessToken}` })
      .expect(200)
    expect((lista.body as Array<{ id: string }>).map((e) => e.id)).not.toContain(evento)
  })
})

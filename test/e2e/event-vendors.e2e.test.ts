import type { Server } from 'node:http'

import { type INestApplication } from '@nestjs/common'
import { NestFactory } from '@nestjs/core'
import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import cookieParser from 'cookie-parser'
import request from 'supertest'

import { AppModule } from '@/app.module'
import { DomainExceptionFilter } from '@/shared/http/domain-exception.filter'

import { startPostgres, type PostgresDeTest } from '../support/containers'

interface CuerpoError {
  code: string
  message: string
}

interface CuerpoEventVendor {
  id: string
  eventId: string
  vendorRef: { kind: 'linked'; vendorProfileId: string } | { kind: 'external'; name: string }
  category: string
  status: string
}

/**
 * Prueba que la autorización REALMENTE se dispara en las cuatro rutas de
 * `EventVendorsController`: el decorador `@RequireEventAccess` es inerte sin
 * `@UseGuards(EventAccessGuard)` (ver notas de la Tarea 10), así que un test
 * contra el servidor real —no una llamada directa al guard— es la única
 * prueba de que los dos están de verdad enganchados en estas rutas.
 */
describe('Vendors por evento e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: INestApplication
  let server: Server
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let fotografo: { id: string; accessToken: string }
  let evento: string
  let perfilFotografo: string

  async function registrarYEntrar(
    email: string,
    fullName: string,
  ): Promise<{ id: string; accessToken: string }> {
    const registro = await request(server)
      .post('/auth/register')
      .send({ email, password: 'una-contraseña-larga', fullName })
      .expect(201)

    const login = await request(server)
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

    process.env.NODE_ENV = 'test'
    process.env.DATABASE_URL = pg.url
    process.env.REDIS_URL = redis.getConnectionUrl()
    process.env.JWT_ACCESS_SECRET = 'x'.repeat(32)
    process.env.JWT_ACCESS_TTL = '15m'
    process.env.REFRESH_TTL_DAYS = '30'
    process.env.MAIL_DRIVER = 'fake'
    process.env.APP_URL = 'http://localhost:5173'

    app = await NestFactory.create(AppModule, { logger: false })
    app.use(cookieParser())
    app.useGlobalFilters(new DomainExceptionFilter())
    await app.init()
    server = app.getHttpServer() as Server
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')
    fotografo = await registrarYEntrar('foto@test.com', 'Fotógrafo')

    const respuesta = await request(server)
      .post('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Boda de Ana', weddingDate: '2027-06-12T00:00:00.000Z' })
      .expect(201)
    evento = (respuesta.body as { id: string }).id
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('sin token no se llega ni a saber si el evento existe: 401', async () => {
    await request(server).get(`/events/${evento}/vendors`).expect(401)
  })

  it('quien no tiene acceso al evento recibe 404, no 403', async () => {
    const respuesta = await request(server)
      .get(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('NOT_FOUND')
  })

  it('el COUPLE del evento contrata a un proveedor externo', async () => {
    const respuesta = await request(server)
      .post(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({
        externalName: 'Flores Pepa',
        externalEmail: 'pepa@flores.es',
        category: 'Floristería',
      })
      .expect(201)

    const cuerpo = respuesta.body as CuerpoEventVendor
    expect(cuerpo).toMatchObject({
      eventId: evento,
      category: 'Floristería',
      status: 'SHORTLISTED',
      vendorRef: { kind: 'external', name: 'Flores Pepa' },
    })

    const auditoria = await prisma.auditLog.findMany({
      where: { eventId: evento, action: 'event_vendor.added' },
    })
    expect(auditoria).toHaveLength(1)
    expect(auditoria[0]).toMatchObject({ actorUserId: ana.id, target: `event_vendor:${cuerpo.id}` })
  })

  it('rechaza traer ficha del marketplace y datos externos a la vez: 422', async () => {
    const respuesta = await request(server)
      .post(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ vendorProfileId: 'lo-que-sea', externalName: 'Flores Pepa', category: 'Floristería' })
      .expect(422)

    expect((respuesta.body as CuerpoError).code).toBe('VENDOR_REF_AMBIGUA')
  })

  it('rechaza enlazar una ficha del marketplace que no está PUBLISHED: 404', async () => {
    const perfil = await prisma.vendorProfile.create({
      data: { userId: fotografo.id, businessName: 'Lumière', category: 'Fotografía' },
    })
    perfilFotografo = perfil.id

    const respuesta = await request(server)
      .post(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ vendorProfileId: perfil.id, category: 'Fotografía' })
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('VENDOR_PROFILE_NOT_AVAILABLE')
  })

  it('enlaza una ficha PUBLISHED del marketplace', async () => {
    // Se publica la MISMA ficha (una por usuario, `userId` es único en
    // `VendorProfile`) en vez de crear una segunda para el mismo fotógrafo.
    await prisma.vendorProfile.update({
      where: { id: perfilFotografo },
      data: { status: 'PUBLISHED' },
    })

    const respuesta = await request(server)
      .post(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ vendorProfileId: perfilFotografo, category: 'Fotografía' })
      .expect(201)

    expect((respuesta.body as CuerpoEventVendor).vendorRef).toEqual({
      kind: 'linked',
      vendorProfileId: perfilFotografo,
    })
  })

  it('lista los proveedores del evento', async () => {
    const respuesta = await request(server)
      .get(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    expect((respuesta.body as CuerpoEventVendor[]).length).toBeGreaterThanOrEqual(2)
  })

  it('actualiza el status de un proveedor', async () => {
    const listado = await request(server)
      .get(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    const [primero] = listado.body as CuerpoEventVendor[]

    const respuesta = await request(server)
      .patch(`/events/${evento}/vendors/${primero?.id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ status: 'BOOKED' })
      .expect(200)

    expect((respuesta.body as CuerpoEventVendor).status).toBe('BOOKED')
  })

  it('un PATCH sobre un id inexistente responde 404', async () => {
    const respuesta = await request(server)
      .patch(`/events/${evento}/vendors/00000000-0000-4000-8000-000000000000`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ status: 'BOOKED' })
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('EVENT_VENDOR_NOT_FOUND')
  })

  it('un vendor BOOKED tiene acceso al evento pero NO puede gestionar vendors: 403', async () => {
    const perfil = await prisma.vendorProfile.findFirstOrThrow({
      where: { userId: fotografo.id },
    })
    await prisma.eventVendor.updateMany({
      where: { eventId: evento, vendorProfileId: perfil.id },
      data: { status: 'BOOKED' },
    })

    // Tiene acceso: la lectura sin @RequireEventAccess de /events/:id le deja
    // entrar (ver test e2e de eventos). Aquí, en cambio, SÍ hay lista y él no
    // está en ella.
    const negado = await request(server)
      .post(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${fotografo.accessToken}`)
      .send({ externalName: 'Otro', category: 'Otra' })
      .expect(403)

    expect((negado.body as CuerpoError).code).toBe('FORBIDDEN')
  })

  it('elimina un proveedor', async () => {
    const creado = await request(server)
      .post(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ externalName: 'Para borrar', category: 'Varios' })
      .expect(201)
    const id = (creado.body as CuerpoEventVendor).id

    await request(server)
      .delete(`/events/${evento}/vendors/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const restante = await prisma.eventVendor.findUnique({ where: { id } })
    expect(restante).toBeNull()
  })
})

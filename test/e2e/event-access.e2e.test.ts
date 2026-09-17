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

interface CuerpoEvento {
  id: string
  name: string
}

const INVENTADO = '00000000-0000-4000-8000-000000000000'

describe('Acceso a eventos e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: INestApplication
  let server: Server
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let pedro: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let eventoDeAna: string
  let eventoDePedro: string

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

  async function crearEvento(accessToken: string, name: string): Promise<string> {
    const respuesta = await request(server)
      .post('/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name, weddingDate: '2027-06-12T00:00:00.000Z' })
      .expect(201)
    return (respuesta.body as CuerpoEvento).id
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
    pedro = await registrarYEntrar('pedro@test.com', 'Pedro')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')

    eventoDeAna = await crearEvento(ana.accessToken, 'Boda de Ana')
    eventoDePedro = await crearEvento(pedro.accessToken, 'Boda de Pedro')
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('quien crea el evento entra: el evento y su membresía nacen juntos', async () => {
    const respuesta = await request(server)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    expect(respuesta.body).toMatchObject({
      id: eventoDeAna,
      name: 'Boda de Ana',
      access: { kind: 'member', role: 'COUPLE' },
    })
  })

  it('un usuario sin acceso recibe 404, no 403', async () => {
    const respuesta = await request(server)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    // El cuerpo no debe distinguirse del de un evento que no existe.
    const inventado = await request(server)
      .get(`/events/${INVENTADO}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe((inventado.body as CuerpoError).code)
    expect((respuesta.body as CuerpoError).message).toBe((inventado.body as CuerpoError).message)
  })

  it('un id que ni siquiera es un UUID responde igual: 404, no 500', async () => {
    const respuesta = await request(server)
      .get('/events/no-es-un-uuid')
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('NOT_FOUND')
  })

  it('sin token no se llega ni a saber si el evento existe', async () => {
    await request(server).get(`/events/${eventoDeAna}`).expect(401)
  })

  it('invitar deja la membresía en INVITED, y una invitación sin aceptar no abre nada', async () => {
    await request(server)
      .post(`/events/${eventoDeAna}/members`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ email: 'pedro@test.com', role: 'PLANNER' })
      .expect(201)

    const membresia = await prisma.eventMembership.findUnique({
      where: { eventId_userId: { eventId: eventoDeAna, userId: pedro.id } },
    })
    expect(membresia).toMatchObject({ role: 'PLANNER', status: 'INVITED' })

    // Invitado pero no aceptado: sigue siendo 404, el mismo que para un extraño.
    await request(server)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .expect(404)

    // Y quedó rastro de quién invitó a quién.
    const auditoria = await prisma.auditLog.findMany({ where: { eventId: eventoDeAna } })
    expect(auditoria).toHaveLength(1)
    expect(auditoria[0]).toMatchObject({
      actorUserId: ana.id,
      action: 'event.member.invited',
      target: `user:${pedro.id}`,
    })
  })

  it('un planner activo entra al evento, pero NO puede invitar: ahí sí es 403', async () => {
    // No existe todavía el endpoint para aceptar una invitación (es de una
    // tarea posterior), así que la aceptación se simula escribiendo la fila.
    await prisma.eventMembership.update({
      where: { eventId_userId: { eventId: eventoDeAna, userId: pedro.id } },
      data: { status: 'ACTIVE' },
    })

    await request(server)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .expect(200)

    // 403 y no 404: Pedro YA sabe que el evento existe, así que negarle esta
    // operación concreta no le revela nada que no tuviera.
    const negado = await request(server)
      .post(`/events/${eventoDeAna}/members`)
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .send({ email: 'extrano@test.com', role: 'PLANNER' })
      .expect(403)

    expect((negado.body as CuerpoError).code).toBe('FORBIDDEN')
  })

  it('cada quien ve en su lista sólo los eventos a los que tiene acceso', async () => {
    const deAna = await request(server)
      .get('/events')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const dePedro = await request(server)
      .get('/events')
      .set('Authorization', `Bearer ${pedro.accessToken}`)
      .expect(200)

    const deExtrano = await request(server)
      .get('/events')
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(200)

    expect((deAna.body as CuerpoEvento[]).map((e) => e.id)).toEqual([eventoDeAna])
    // Pedro es COUPLE del suyo y PLANNER ya activo en el de Ana.
    expect((dePedro.body as CuerpoEvento[]).map((e) => e.id).sort()).toEqual(
      [eventoDeAna, eventoDePedro].sort(),
    )
    expect(deExtrano.body).toEqual([])
  })

  it('un vendor sólo entra cuando la contratación está BOOKED', async () => {
    const perfil = await prisma.vendorProfile.create({
      data: { userId: extrano.id, businessName: 'Lumière', category: 'Catering' },
    })
    const contratacion = await prisma.eventVendor.create({
      data: { eventId: eventoDeAna, vendorProfileId: perfil.id, category: 'Catering' },
    })

    // SHORTLISTED: todavía no es nadie en este evento.
    await request(server)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    await prisma.eventVendor.update({
      where: { id: contratacion.id },
      data: { status: 'BOOKED' },
    })

    const respuesta = await request(server)
      .get(`/events/${eventoDeAna}`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(200)
    expect(respuesta.body).toMatchObject({
      access: { kind: 'vendor', eventVendorId: contratacion.id },
    })

    // Pero un vendor no invita a nadie: tiene acceso, no mando.
    await request(server)
      .post(`/events/${eventoDeAna}/members`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .send({ email: 'pedro@test.com', role: 'PLANNER' })
      .expect(403)
  })
})

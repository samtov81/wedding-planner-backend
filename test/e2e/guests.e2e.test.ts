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

interface CuerpoInvitado {
  id: string
  eventId: string
  name: string
  email: string | null
  group: string
  rsvp: 'CONFIRMED' | 'PENDING' | 'DECLINED'
  dietary: string | null
}

interface CuerpoPagina {
  items: CuerpoInvitado[]
  nextCursor: string | null
}

interface CuerpoResumen {
  total: number
  confirmed: number
  pending: number
  declined: number
}

describe('Invitados e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let app: INestApplication
  let server: Server
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let beto: { id: string; accessToken: string }
  let planner: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let fotografo: { id: string; accessToken: string }

  /** Dos bodas distintas: la de Ana y la de Beto. El planner está en las dos. */
  let bodaDeAna: string
  let bodaDeBeto: string

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

  async function crearEvento(token: string, nombre: string): Promise<string> {
    const respuesta = await request(server)
      .post('/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: nombre, weddingDate: '2027-06-12T00:00:00.000Z' })
      .expect(201)
    return (respuesta.body as { id: string }).id
  }

  /**
   * Invita al planner y ACTIVA la membresía a mano. Todavía no existe el
   * endpoint de aceptar invitación (queda fuera de esta tarea) y una membresía
   * `INVITED` no concede acceso — es justo lo que comprueba el e2e de eventos.
   */
  async function meterPlannerEn(eventoId: string, tokenDelCouple: string): Promise<void> {
    await request(server)
      .post(`/events/${eventoId}/members`)
      .set('Authorization', `Bearer ${tokenDelCouple}`)
      .send({ email: 'planner@test.com', role: 'PLANNER' })
      .expect(201)

    await prisma.eventMembership.updateMany({
      where: { eventId: eventoId, userId: planner.id },
      data: { status: 'ACTIVE' },
    })
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
    beto = await registrarYEntrar('beto@test.com', 'Beto')
    planner = await registrarYEntrar('planner@test.com', 'Planner')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')
    fotografo = await registrarYEntrar('foto@test.com', 'Fotógrafo')

    bodaDeAna = await crearEvento(ana.accessToken, 'Boda de Ana')
    bodaDeBeto = await crearEvento(beto.accessToken, 'Boda de Beto')

    await meterPlannerEn(bodaDeAna, ana.accessToken)
    await meterPlannerEn(bodaDeBeto, beto.accessToken)
  }, 240_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await app.close()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('sin token no se llega ni a saber si el evento existe: 401', async () => {
    await request(server).get(`/events/${bodaDeAna}/guests`).expect(401)
  })

  it('un usuario sin relación con el evento recibe 404', async () => {
    const respuesta = await request(server)
      .get(`/events/${bodaDeAna}/guests`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('NOT_FOUND')
  })

  it('crea un invitado sin email', async () => {
    const respuesta = await request(server)
      .post(`/events/${bodaDeAna}/guests`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Tía Carmen', group: 'Family' })
      .expect(201)

    const invitado = respuesta.body as CuerpoInvitado
    expect(invitado.email).toBeNull()
    expect(invitado.rsvp).toBe('PENDING')
    expect(invitado.eventId).toBe(bodaDeAna)
  })

  it('rechaza invitar dos veces al mismo correo en el mismo evento: 409', async () => {
    await request(server)
      .post(`/events/${bodaDeAna}/guests`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Primo Luis', email: 'luis@test.com', group: 'Family' })
      .expect(201)

    const repetido = await request(server)
      .post(`/events/${bodaDeAna}/guests`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Luis otra vez', email: 'luis@test.com', group: 'Work' })
      .expect(409)

    expect((repetido.body as CuerpoError).code).toBe('GUEST_EMAIL_DUPLICATED')
  })

  it('el mismo correo SÍ puede estar invitado a otra boda', async () => {
    await request(server)
      .post(`/events/${bodaDeBeto}/guests`)
      .set('Authorization', `Bearer ${beto.accessToken}`)
      .send({ name: 'Primo Luis', email: 'luis@test.com', group: 'Family' })
      .expect(201)
  })

  it('un planner con DOS eventos ve sólo los invitados de cada uno', async () => {
    // Requisito arrastrado de la Tarea 9, que no pudo escribirlo porque ni
    // `Guest` ni esta ruta existían. Es el test de aislamiento entre eventos
    // del módulo: la misma identidad, con acceso legítimo a las dos bodas,
    // no debe ver nunca una mezcla.
    await request(server)
      .post(`/events/${bodaDeBeto}/guests`)
      .set('Authorization', `Bearer ${planner.accessToken}`)
      .send({ name: 'Invitado de Beto', group: 'Friends' })
      .expect(201)

    const deAna = await request(server)
      .get(`/events/${bodaDeAna}/guests?limit=100`)
      .set('Authorization', `Bearer ${planner.accessToken}`)
      .expect(200)
    const deBeto = await request(server)
      .get(`/events/${bodaDeBeto}/guests?limit=100`)
      .set('Authorization', `Bearer ${planner.accessToken}`)
      .expect(200)

    const itemsDeAna = (deAna.body as CuerpoPagina).items
    const itemsDeBeto = (deBeto.body as CuerpoPagina).items

    expect(itemsDeAna.length).toBeGreaterThan(0)
    expect(itemsDeBeto.length).toBeGreaterThan(0)
    expect(itemsDeAna.every((g) => g.eventId === bodaDeAna)).toBe(true)
    expect(itemsDeBeto.every((g) => g.eventId === bodaDeBeto)).toBe(true)

    // Y ningún id se repite entre las dos listas: una mezcla se vería aquí
    // aunque los dos `eventId` de arriba cuadraran por casualidad.
    const idsDeAna = new Set(itemsDeAna.map((g) => g.id))
    expect(itemsDeBeto.some((g) => idsDeAna.has(g.id))).toBe(false)
    expect(itemsDeAna.map((g) => g.name)).not.toContain('Invitado de Beto')

    // Un invitado de la boda de Beto, pedido por la ruta de la de Ana, es 404:
    // el id existe, pero no en ESE evento.
    const ajeno = itemsDeBeto[0]
    if (ajeno === undefined) throw new Error('la boda de Beto debería tener invitados')
    await request(server)
      .get(`/events/${bodaDeAna}/guests/${ajeno.id}`)
      .set('Authorization', `Bearer ${planner.accessToken}`)
      .expect(404)
  })

  it('pagina con cursor a través de HTTP y acaba con nextCursor null', async () => {
    for (let i = 0; i < 5; i += 1) {
      await request(server)
        .post(`/events/${bodaDeAna}/guests`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ name: `Página ${i}`, group: 'Friends' })
        .expect(201)
    }

    const primera = await request(server)
      .get(`/events/${bodaDeAna}/guests?limit=3`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    const pagina1 = primera.body as CuerpoPagina
    expect(pagina1.items).toHaveLength(3)
    expect(pagina1.nextCursor).not.toBeNull()

    const vistos = new Set(pagina1.items.map((g) => g.id))
    let cursor = pagina1.nextCursor
    while (cursor !== null) {
      const siguiente = await request(server)
        .get(`/events/${bodaDeAna}/guests?limit=3&cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .expect(200)
      const pagina = siguiente.body as CuerpoPagina
      for (const g of pagina.items) {
        expect(vistos.has(g.id)).toBe(false)
        vistos.add(g.id)
      }
      cursor = pagina.nextCursor
    }

    const todos = await prisma.guest.count({ where: { eventId: bodaDeAna } })
    expect(vistos.size).toBe(todos)
  })

  it('un cursor inventado es 400, no un 500', async () => {
    const respuesta = await request(server)
      .get(`/events/${bodaDeAna}/guests?cursor=no-es-un-cursor`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(400)

    expect((respuesta.body as CuerpoError).code).toBe('INVALID_CURSOR')
  })

  it('rechaza un limit fuera de rango: 400', async () => {
    await request(server)
      .get(`/events/${bodaDeAna}/guests?limit=1000000`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(400)
  })

  it('filtra por rsvp y por grupo desde la query', async () => {
    const respuesta = await request(server)
      .get(`/events/${bodaDeAna}/guests?rsvp=PENDING&group=Friends&limit=100`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const items = (respuesta.body as CuerpoPagina).items
    expect(items.length).toBeGreaterThan(0)
    expect(items.every((g) => g.rsvp === 'PENDING' && g.group === 'Friends')).toBe(true)
  })

  it('GET /summary es el resumen, no un invitado con id "summary"', async () => {
    const respuesta = await request(server)
      .get(`/events/${bodaDeAna}/guests/summary`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const resumen = respuesta.body as CuerpoResumen
    const total = await prisma.guest.count({ where: { eventId: bodaDeAna } })
    expect(resumen.total).toBe(total)
    expect(resumen.confirmed + resumen.pending + resumen.declined).toBe(resumen.total)
  })

  it('el resumen se mueve al cambiar un RSVP, sin ninguna columna de contador', async () => {
    const antes = (
      await request(server)
        .get(`/events/${bodaDeAna}/guests/summary`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .expect(200)
    ).body as CuerpoResumen

    const alguien = await prisma.guest.findFirstOrThrow({
      where: { eventId: bodaDeAna, rsvp: 'PENDING' },
    })

    await request(server)
      .patch(`/events/${bodaDeAna}/guests/${alguien.id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ rsvp: 'CONFIRMED' })
      .expect(200)

    const despues = (
      await request(server)
        .get(`/events/${bodaDeAna}/guests/summary`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .expect(200)
    ).body as CuerpoResumen

    expect(despues.confirmed).toBe(antes.confirmed + 1)
    expect(despues.pending).toBe(antes.pending - 1)
    expect(despues.total).toBe(antes.total)
  })

  it('actualiza y borra un invitado', async () => {
    const creado = (
      await request(server)
        .post(`/events/${bodaDeAna}/guests`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ name: 'Para borrar', group: 'Work' })
        .expect(201)
    ).body as CuerpoInvitado

    const actualizado = (
      await request(server)
        .patch(`/events/${bodaDeAna}/guests/${creado.id}`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ dietary: 'Sin gluten', rsvp: 'DECLINED' })
        .expect(200)
    ).body as CuerpoInvitado
    expect(actualizado).toMatchObject({ dietary: 'Sin gluten', rsvp: 'DECLINED' })

    await request(server)
      .delete(`/events/${bodaDeAna}/guests/${creado.id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    expect(await prisma.guest.findUnique({ where: { id: creado.id } })).toBeNull()
  })

  it('un PATCH sobre un invitado inexistente responde 404', async () => {
    const respuesta = await request(server)
      .patch(`/events/${bodaDeAna}/guests/00000000-0000-4000-8000-000000000000`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ rsvp: 'CONFIRMED' })
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('GUEST_NOT_FOUND')
  })

  it('un vendor contratado NO puede tocar NINGUNA de las seis rutas: 403', async () => {
    // `@RequireEventAccess` es inerte si falta en un método (el guard sólo mira
    // el handler), y un decorador que falta se ve igual que uno que está. Por
    // eso se comprueban las SEIS rutas, no sólo el listado: con una sola, el
    // día que alguien olvide el decorador en el DELETE la suite seguiría verde.
    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: fotografo.id,
        businessName: 'Lumière',
        category: 'Fotografía',
        status: 'PUBLISHED',
      },
    })
    await prisma.eventVendor.create({
      data: {
        eventId: bodaDeAna,
        vendorProfileId: perfil.id,
        category: 'Fotografía',
        status: 'BOOKED',
      },
    })

    // Tiene acceso al evento: `GET /events/:id` (sin @RequireEventAccess) le
    // deja entrar. Lo que no tiene es permiso sobre los invitados.
    await request(server)
      .get(`/events/${bodaDeAna}`)
      .set('Authorization', `Bearer ${fotografo.accessToken}`)
      .expect(200)

    const victima = await prisma.guest.findFirstOrThrow({ where: { eventId: bodaDeAna } })
    const token = `Bearer ${fotografo.accessToken}`

    // Cada petición en su propio thunk: supertest arranca el servidor al
    // construir la petición, y seis a la vez se pisan el puerto (ECONNREFUSED).
    const negados = [
      () => request(server).get(`/events/${bodaDeAna}/guests`).set('Authorization', token),
      () => request(server).get(`/events/${bodaDeAna}/guests/summary`).set('Authorization', token),
      () =>
        request(server)
          .post(`/events/${bodaDeAna}/guests`)
          .set('Authorization', token)
          .send({ name: 'Colado', group: 'Work' }),
      () =>
        request(server)
          .get(`/events/${bodaDeAna}/guests/${victima.id}`)
          .set('Authorization', token),
      () =>
        request(server)
          .patch(`/events/${bodaDeAna}/guests/${victima.id}`)
          .set('Authorization', token)
          .send({ rsvp: 'DECLINED' }),
      () =>
        request(server)
          .delete(`/events/${bodaDeAna}/guests/${victima.id}`)
          .set('Authorization', token),
    ]

    for (const peticion of negados) {
      const respuesta = await peticion().expect(403)
      expect((respuesta.body as CuerpoError).code).toBe('FORBIDDEN')
    }

    // Y que ninguno de los intentos haya tocado nada.
    const sigueIgual = await prisma.guest.findUnique({ where: { id: victima.id } })
    expect(sigueIgual).not.toBeNull()
    expect(sigueIgual?.rsvp).toBe(victima.rsvp)
    expect(await prisma.guest.count({ where: { eventId: bodaDeAna, name: 'Colado' } })).toBe(0)
  })
})

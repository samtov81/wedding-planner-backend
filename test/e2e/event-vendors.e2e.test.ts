import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { arrancarAppDeTest, fijarEntorno } from '../support/app'
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
 *
 * Tarea 2 (endurecimiento): cada test que necesita estado propio (un perfil
 * PUBLISHED, un listado con un total exacto, un vendor BOOKED) se lo crea con
 * su propio usuario y su propio evento en vez de heredarlo de un test
 * anterior — así corre igual aislado, con `--sequence.shuffle`, o dentro de
 * la suite completa.
 */
describe('Vendors por evento e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }
  let fotografo: { id: string; accessToken: string }
  let evento: string

  async function registrarYEntrar(
    email: string,
    fullName: string,
  ): Promise<{ id: string; accessToken: string }> {
    const registro = await request(url)
      .post('/auth/register')
      .send({ email, password: 'una-contraseña-larga', fullName })
      .expect(201)

    const login = await request(url)
      .post('/auth/login')
      .send({ email, password: 'una-contraseña-larga' })
      .expect(200)

    return {
      id: (registro.body as { id: string }).id,
      accessToken: (login.body as { accessToken: string }).accessToken,
    }
  }

  async function crearEvento(accessToken: string, name: string): Promise<string> {
    const respuesta = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name, weddingDate: '2027-06-12T00:00:00.000Z' })
      .expect(201)
    return (respuesta.body as { id: string }).id
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')
    fotografo = await registrarYEntrar('foto@test.com', 'Fotógrafo')

    evento = await crearEvento(ana.accessToken, 'Boda de Ana')
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('sin token no se llega ni a saber si el evento existe: 401', async () => {
    await request(url).get(`/events/${evento}/vendors`).expect(401)
  })

  it('quien no tiene acceso al evento recibe 404, no 403', async () => {
    const respuesta = await request(url)
      .get(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('NOT_FOUND')
  })

  it('el COUPLE del evento contrata a un proveedor externo', async () => {
    const respuesta = await request(url)
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

    // Filtrado también por `target`: `evento` es compartido con otros tests
    // de este fichero que también añaden vendors (p. ej. "elimina un
    // proveedor"), así que un filtro sólo por `eventId` + `action` cuenta
    // auditoría ajena bajo `--sequence.shuffle`.
    const auditoria = await prisma.auditLog.findMany({
      where: { eventId: evento, action: 'event_vendor.added', target: `event_vendor:${cuerpo.id}` },
    })
    expect(auditoria).toHaveLength(1)
    expect(auditoria[0]).toMatchObject({ actorUserId: ana.id, target: `event_vendor:${cuerpo.id}` })
  })

  it('rechaza traer ficha del marketplace y datos externos a la vez: 422', async () => {
    const respuesta = await request(url)
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

    const respuesta = await request(url)
      .post(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ vendorProfileId: perfil.id, category: 'Fotografía' })
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('VENDOR_PROFILE_NOT_AVAILABLE')
  })

  it('enlaza una ficha PUBLISHED del marketplace', async () => {
    // `VendorProfile.userId` es único, así que este test registra SU PROPIO
    // fotógrafo en vez de reutilizar `fotografo` (que el test anterior ya usó
    // para una ficha no-PUBLISHED) o depender de que ese test corriera antes.
    const fotografoPropio = await registrarYEntrar(
      `foto-${randomUUID()}@test.com`,
      'Fotógrafo Propio',
    )
    const eventoPropio = await crearEvento(ana.accessToken, 'Boda para enlazar ficha')

    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: fotografoPropio.id,
        businessName: 'Lumière',
        category: 'Fotografía',
        status: 'PUBLISHED',
      },
    })

    const respuesta = await request(url)
      .post(`/events/${eventoPropio}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ vendorProfileId: perfil.id, category: 'Fotografía' })
      .expect(201)

    expect((respuesta.body as CuerpoEventVendor).vendorRef).toEqual({
      kind: 'linked',
      vendorProfileId: perfil.id,
    })
  })

  it('lista los proveedores del evento', async () => {
    const eventoPropio = await crearEvento(ana.accessToken, 'Boda para listar proveedores')

    await request(url)
      .post(`/events/${eventoPropio}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({
        externalName: 'Flores Pepa',
        externalEmail: 'pepa@flores.es',
        category: 'Floristería',
      })
      .expect(201)
    await request(url)
      .post(`/events/${eventoPropio}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({
        externalName: 'Catering Uno',
        externalEmail: 'catering@uno.es',
        category: 'Catering',
      })
      .expect(201)

    const respuesta = await request(url)
      .get(`/events/${eventoPropio}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const proveedores = respuesta.body as CuerpoEventVendor[]
    expect(proveedores).toHaveLength(2)
    expect(proveedores.every((v) => v.eventId === eventoPropio)).toBe(true)
  })

  it('actualiza el status de un proveedor', async () => {
    const eventoPropio = await crearEvento(ana.accessToken, 'Boda para actualizar status')

    const creado = await request(url)
      .post(`/events/${eventoPropio}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({
        externalName: 'Flores Pepa',
        externalEmail: 'pepa@flores.es',
        category: 'Floristería',
      })
      .expect(201)
    const id = (creado.body as CuerpoEventVendor).id

    const respuesta = await request(url)
      .patch(`/events/${eventoPropio}/vendors/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ status: 'BOOKED' })
      .expect(200)

    expect((respuesta.body as CuerpoEventVendor).status).toBe('BOOKED')
  })

  it('un PATCH sobre un id inexistente responde 404', async () => {
    const respuesta = await request(url)
      .patch(`/events/${evento}/vendors/00000000-0000-4000-8000-000000000000`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ status: 'BOOKED' })
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('EVENT_VENDOR_NOT_FOUND')
  })

  it('un eventVendorId mal formado responde 404, no 500: Prisma nunca ve un id que no es UUID', async () => {
    const respuestaPatch = await request(url)
      .patch(`/events/${evento}/vendors/no-es-uuid`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ status: 'BOOKED' })
      .expect(404)
    expect((respuestaPatch.body as CuerpoError).code).toBe('EVENT_VENDOR_NOT_FOUND')

    const respuestaDelete = await request(url)
      .delete(`/events/${evento}/vendors/no-es-uuid`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(404)
    expect((respuestaDelete.body as CuerpoError).code).toBe('EVENT_VENDOR_NOT_FOUND')
  })

  it('un vendor BOOKED tiene acceso al evento pero NO puede gestionar vendors: 403', async () => {
    const fotografoPropio = await registrarYEntrar(
      `foto-${randomUUID()}@test.com`,
      'Fotógrafo Propio',
    )
    const eventoPropio = await crearEvento(ana.accessToken, 'Boda para vendor BOOKED')

    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: fotografoPropio.id,
        businessName: 'Lumière',
        category: 'Fotografía',
        status: 'PUBLISHED',
      },
    })
    const contratacion = await prisma.eventVendor.create({
      data: {
        eventId: eventoPropio,
        vendorProfileId: perfil.id,
        category: 'Fotografía',
        status: 'BOOKED',
      },
    })

    // Ronda de arreglo 1, hallazgo Important #2 (C12): comprobar sólo POST
    // dejaba que quitar el decorador de PATCH o DELETE pasara desapercibido.
    // Se repiten las cuatro rutas con el mismo `contratacion` que este test
    // ya creó.
    const negado = await request(url)
      .post(`/events/${eventoPropio}/vendors`)
      .set('Authorization', `Bearer ${fotografoPropio.accessToken}`)
      .send({ externalName: 'Otro', category: 'Otra' })
      .expect(403)
    expect((negado.body as CuerpoError).code).toBe('FORBIDDEN')

    const negadoGet = await request(url)
      .get(`/events/${eventoPropio}/vendors`)
      .set('Authorization', `Bearer ${fotografoPropio.accessToken}`)
      .expect(403)
    expect((negadoGet.body as CuerpoError).code).toBe('FORBIDDEN')

    const negadoPatch = await request(url)
      .patch(`/events/${eventoPropio}/vendors/${contratacion.id}`)
      .set('Authorization', `Bearer ${fotografoPropio.accessToken}`)
      .send({ status: 'CANCELLED' })
      .expect(403)
    expect((negadoPatch.body as CuerpoError).code).toBe('FORBIDDEN')

    const negadoDelete = await request(url)
      .delete(`/events/${eventoPropio}/vendors/${contratacion.id}`)
      .set('Authorization', `Bearer ${fotografoPropio.accessToken}`)
      .expect(403)
    expect((negadoDelete.body as CuerpoError).code).toBe('FORBIDDEN')

    const sigueIgual = await prisma.eventVendor.findUnique({ where: { id: contratacion.id } })
    expect(sigueIgual).not.toBeNull()
    expect(sigueIgual?.status).not.toBe('CANCELLED')
  })

  it('añadir, actualizar y borrar un proveedor externo deja tres AuditLog sin datos personales en metadata', async () => {
    const eventoPropio = await crearEvento(ana.accessToken, 'Boda para auditoría sin PII')
    const nombre = 'Flores Auditoría'
    const email = 'auditoria@flores.es'
    const telefono = '+34600111222'

    const creado = await request(url)
      .post(`/events/${eventoPropio}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({
        externalName: nombre,
        externalEmail: email,
        externalPhone: telefono,
        category: 'Floristería',
      })
      .expect(201)
    const id = (creado.body as CuerpoEventVendor).id

    await request(url)
      .patch(`/events/${eventoPropio}/vendors/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ status: 'BOOKED' })
      .expect(200)

    await request(url)
      .delete(`/events/${eventoPropio}/vendors/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const auditoria = await prisma.auditLog.findMany({
      where: { eventId: eventoPropio, target: `event_vendor:${id}` },
      orderBy: { createdAt: 'asc' },
    })
    expect(auditoria.map((fila) => fila.action)).toEqual([
      'event_vendor.added',
      'event_vendor.updated',
      'event_vendor.removed',
    ])
    for (const fila of auditoria) {
      expect(fila.actorUserId).toBe(ana.id)
      const metadataJson = JSON.stringify(fila.metadata)
      expect(metadataJson).not.toContain(nombre)
      expect(metadataJson).not.toContain(email)
      expect(metadataJson).not.toContain(telefono)
    }
  })

  it('elimina un proveedor', async () => {
    const creado = await request(url)
      .post(`/events/${evento}/vendors`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ externalName: 'Para borrar', category: 'Varios' })
      .expect(201)
    const id = (creado.body as CuerpoEventVendor).id

    await request(url)
      .delete(`/events/${evento}/vendors/${id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const restante = await prisma.eventVendor.findUnique({ where: { id } })
    expect(restante).toBeNull()
  })
})

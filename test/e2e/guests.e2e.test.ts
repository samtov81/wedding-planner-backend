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

interface CuerpoEnvio {
  queued: Array<{ guestId: string; invitationId: string }>
  skipped: Array<{ guestId: string; reason: 'NO_EMAIL' | 'ALREADY_RESPONDED' }>
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
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let beto: { id: string; accessToken: string }
  let extrano: { id: string; accessToken: string }

  /** Dos bodas distintas: la de Ana y la de Beto. */
  let bodaDeAna: string
  let bodaDeBeto: string

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

  async function crearEvento(token: string, nombre: string): Promise<string> {
    const respuesta = await request(url)
      .post('/events')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: nombre, weddingDate: '2027-06-12T00:00:00.000Z' })
      .expect(201)
    return (respuesta.body as { id: string }).id
  }

  /**
   * Invita a `plannerEmail`/`plannerId` a `eventoId` y ACTIVA la membresía a
   * mano. Todavía no existe el endpoint de aceptar invitación (queda fuera de
   * esta tarea) y una membresía `INVITED` no concede acceso — es justo lo que
   * comprueba el e2e de eventos. Parametrizado por planner para que cada test
   * que necesite uno se cree el suyo propio.
   */
  async function meterPlannerEn(
    eventoId: string,
    tokenDelCouple: string,
    plannerEmail: string,
    plannerId: string,
  ): Promise<void> {
    await request(url)
      .post(`/events/${eventoId}/members`)
      .set('Authorization', `Bearer ${tokenDelCouple}`)
      .send({ email: plannerEmail, role: 'PLANNER' })
      .expect(201)

    await prisma.eventMembership.updateMany({
      where: { eventId: eventoId, userId: plannerId },
      data: { status: 'ACTIVE' },
    })
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    beto = await registrarYEntrar('beto@test.com', 'Beto')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')

    bodaDeAna = await crearEvento(ana.accessToken, 'Boda de Ana')
    bodaDeBeto = await crearEvento(beto.accessToken, 'Boda de Beto')
  }, 240_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('sin token no se llega ni a saber si el evento existe: 401', async () => {
    await request(url).get(`/events/${bodaDeAna}/guests`).expect(401)
  })

  it('un usuario sin relación con el evento recibe 404', async () => {
    const respuesta = await request(url)
      .get(`/events/${bodaDeAna}/guests`)
      .set('Authorization', `Bearer ${extrano.accessToken}`)
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('NOT_FOUND')
  })

  it('crea un invitado sin email', async () => {
    const respuesta = await request(url)
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
    const correo = `luis-${randomUUID()}@test.com`
    await request(url)
      .post(`/events/${bodaDeAna}/guests`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Primo Luis', email: correo, group: 'Family' })
      .expect(201)

    const repetido = await request(url)
      .post(`/events/${bodaDeAna}/guests`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Luis otra vez', email: correo, group: 'Work' })
      .expect(409)

    expect((repetido.body as CuerpoError).code).toBe('GUEST_EMAIL_DUPLICATED')
  })

  it('el mismo correo SÍ puede estar invitado a otra boda', async () => {
    // Crea su propio primer invitado (con correo propio) en la boda de Ana,
    // y comprueba que ESE MISMO correo entra sin problema en la de Beto: no
    // depende de que otro test haya dejado ya un correo en `bodaDeAna`.
    const correo = `luis-${randomUUID()}@test.com`
    await request(url)
      .post(`/events/${bodaDeAna}/guests`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ name: 'Primo Luis', email: correo, group: 'Family' })
      .expect(201)

    await request(url)
      .post(`/events/${bodaDeBeto}/guests`)
      .set('Authorization', `Bearer ${beto.accessToken}`)
      .send({ name: 'Primo Luis', email: correo, group: 'Family' })
      .expect(201)
  })

  it('un planner con DOS eventos ve sólo los invitados de cada uno', async () => {
    // Boda A y boda B propias, con un planner propio activo en las dos: el
    // test de aislamiento entre eventos del módulo no debe depender de
    // cuántos invitados dejaron otros tests en `bodaDeAna`/`bodaDeBeto`.
    const anaEmail = `ana-${randomUUID()}@test.com`
    const betoEmail = `beto-${randomUUID()}@test.com`
    const plannerEmail = `planner-${randomUUID()}@test.com`
    const anaPropia = await registrarYEntrar(anaEmail, 'Ana Propia')
    const betoPropio = await registrarYEntrar(betoEmail, 'Beto Propio')
    const plannerPropio = await registrarYEntrar(plannerEmail, 'Planner Propio')

    const bodaA = await crearEvento(anaPropia.accessToken, 'Boda A')
    const bodaB = await crearEvento(betoPropio.accessToken, 'Boda B')
    await meterPlannerEn(bodaA, anaPropia.accessToken, plannerEmail, plannerPropio.id)
    await meterPlannerEn(bodaB, betoPropio.accessToken, plannerEmail, plannerPropio.id)

    await request(url)
      .post(`/events/${bodaA}/guests`)
      .set('Authorization', `Bearer ${anaPropia.accessToken}`)
      .send({ name: 'Invitado de A', group: 'Friends' })
      .expect(201)
    await request(url)
      .post(`/events/${bodaB}/guests`)
      .set('Authorization', `Bearer ${betoPropio.accessToken}`)
      .send({ name: 'Invitado de B', group: 'Friends' })
      .expect(201)

    const deA = await request(url)
      .get(`/events/${bodaA}/guests?limit=100`)
      .set('Authorization', `Bearer ${plannerPropio.accessToken}`)
      .expect(200)
    const deB = await request(url)
      .get(`/events/${bodaB}/guests?limit=100`)
      .set('Authorization', `Bearer ${plannerPropio.accessToken}`)
      .expect(200)

    const itemsDeA = (deA.body as CuerpoPagina).items
    const itemsDeB = (deB.body as CuerpoPagina).items

    expect(itemsDeA).toHaveLength(1)
    expect(itemsDeB).toHaveLength(1)
    expect(itemsDeA.every((g) => g.eventId === bodaA)).toBe(true)
    expect(itemsDeB.every((g) => g.eventId === bodaB)).toBe(true)

    // Y ningún id se repite entre las dos listas: una mezcla se vería aquí
    // aunque los dos `eventId` de arriba cuadraran por casualidad.
    const idsDeA = new Set(itemsDeA.map((g) => g.id))
    expect(itemsDeB.some((g) => idsDeA.has(g.id))).toBe(false)
    expect(itemsDeA.map((g) => g.name)).not.toContain('Invitado de B')

    // Un invitado de la boda B, pedido por la ruta de la boda A, es 404: el
    // id existe, pero no en ESE evento.
    const ajeno = itemsDeB[0]
    if (ajeno === undefined) throw new Error('la boda B debería tener invitados')
    await request(url)
      .get(`/events/${bodaA}/guests/${ajeno.id}`)
      .set('Authorization', `Bearer ${plannerPropio.accessToken}`)
      .expect(404)
  })

  it('pagina con cursor a través de HTTP y acaba con nextCursor null', async () => {
    // Boda propia con un número EXACTO de invitados: pagina sobre un total
    // conocido en vez de contar lo que dejaron otros tests en `bodaDeAna`.
    const anaEmail = `ana-${randomUUID()}@test.com`
    const anaPropia = await registrarYEntrar(anaEmail, 'Ana Propia')
    const bodaPropia = await crearEvento(anaPropia.accessToken, 'Boda de paginación')
    const total = 5

    for (let i = 0; i < total; i += 1) {
      await request(url)
        .post(`/events/${bodaPropia}/guests`)
        .set('Authorization', `Bearer ${anaPropia.accessToken}`)
        .send({ name: `Página ${i}`, group: 'Friends' })
        .expect(201)
    }

    const primera = await request(url)
      .get(`/events/${bodaPropia}/guests?limit=3`)
      .set('Authorization', `Bearer ${anaPropia.accessToken}`)
      .expect(200)
    const pagina1 = primera.body as CuerpoPagina
    expect(pagina1.items).toHaveLength(3)
    expect(pagina1.nextCursor).not.toBeNull()

    const vistos = new Set(pagina1.items.map((g) => g.id))
    let cursor = pagina1.nextCursor
    while (cursor !== null) {
      const siguiente = await request(url)
        .get(`/events/${bodaPropia}/guests?limit=3&cursor=${encodeURIComponent(cursor)}`)
        .set('Authorization', `Bearer ${anaPropia.accessToken}`)
        .expect(200)
      const pagina = siguiente.body as CuerpoPagina
      for (const g of pagina.items) {
        expect(vistos.has(g.id)).toBe(false)
        vistos.add(g.id)
      }
      cursor = pagina.nextCursor
    }

    expect(vistos.size).toBe(total)
  })

  it('un cursor inventado es 400, no un 500', async () => {
    const respuesta = await request(url)
      .get(`/events/${bodaDeAna}/guests?cursor=no-es-un-cursor`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(400)

    expect((respuesta.body as CuerpoError).code).toBe('INVALID_CURSOR')
  })

  it('rechaza un limit fuera de rango: 400', async () => {
    await request(url)
      .get(`/events/${bodaDeAna}/guests?limit=1000000`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(400)
  })

  it('filtra por rsvp y por grupo desde la query', async () => {
    // Boda propia con exactamente un invitado PENDING/Friends: el filtro se
    // comprueba sobre un dato que este test controla, no sobre lo que dejó
    // otro test en `bodaDeAna`.
    const anaEmail = `ana-${randomUUID()}@test.com`
    const anaPropia = await registrarYEntrar(anaEmail, 'Ana Propia')
    const bodaPropia = await crearEvento(anaPropia.accessToken, 'Boda de filtros')

    await request(url)
      .post(`/events/${bodaPropia}/guests`)
      .set('Authorization', `Bearer ${anaPropia.accessToken}`)
      .send({ name: 'Amigo Pendiente', group: 'Friends' })
      .expect(201)
    await request(url)
      .post(`/events/${bodaPropia}/guests`)
      .set('Authorization', `Bearer ${anaPropia.accessToken}`)
      .send({ name: 'Familiar Pendiente', group: 'Family' })
      .expect(201)

    const respuesta = await request(url)
      .get(`/events/${bodaPropia}/guests?rsvp=PENDING&group=Friends&limit=100`)
      .set('Authorization', `Bearer ${anaPropia.accessToken}`)
      .expect(200)

    const items = (respuesta.body as CuerpoPagina).items
    expect(items).toHaveLength(1)
    expect(items.every((g) => g.rsvp === 'PENDING' && g.group === 'Friends')).toBe(true)
  })

  it('GET /summary es el resumen, no un invitado con id "summary"', async () => {
    const respuesta = await request(url)
      .get(`/events/${bodaDeAna}/guests/summary`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    const resumen = respuesta.body as CuerpoResumen
    const total = await prisma.guest.count({ where: { eventId: bodaDeAna } })
    expect(resumen.total).toBe(total)
    expect(resumen.confirmed + resumen.pending + resumen.declined).toBe(resumen.total)
  })

  it('el resumen se mueve al cambiar un RSVP, sin ninguna columna de contador', async () => {
    // Boda propia con un único invitado PENDING: el movimiento del resumen se
    // mide sobre un antes/después que este test controla por completo.
    const anaEmail = `ana-${randomUUID()}@test.com`
    const anaPropia = await registrarYEntrar(anaEmail, 'Ana Propia')
    const bodaPropia = await crearEvento(anaPropia.accessToken, 'Boda del resumen')

    const creado = (
      await request(url)
        .post(`/events/${bodaPropia}/guests`)
        .set('Authorization', `Bearer ${anaPropia.accessToken}`)
        .send({ name: 'Pendiente', group: 'Friends' })
        .expect(201)
    ).body as CuerpoInvitado

    const antes = (
      await request(url)
        .get(`/events/${bodaPropia}/guests/summary`)
        .set('Authorization', `Bearer ${anaPropia.accessToken}`)
        .expect(200)
    ).body as CuerpoResumen

    await request(url)
      .patch(`/events/${bodaPropia}/guests/${creado.id}`)
      .set('Authorization', `Bearer ${anaPropia.accessToken}`)
      .send({ rsvp: 'CONFIRMED' })
      .expect(200)

    const despues = (
      await request(url)
        .get(`/events/${bodaPropia}/guests/summary`)
        .set('Authorization', `Bearer ${anaPropia.accessToken}`)
        .expect(200)
    ).body as CuerpoResumen

    expect(despues.confirmed).toBe(antes.confirmed + 1)
    expect(despues.pending).toBe(antes.pending - 1)
    expect(despues.total).toBe(antes.total)
  })

  it('actualiza y borra un invitado', async () => {
    const creado = (
      await request(url)
        .post(`/events/${bodaDeAna}/guests`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ name: 'Para borrar', group: 'Work' })
        .expect(201)
    ).body as CuerpoInvitado

    const actualizado = (
      await request(url)
        .patch(`/events/${bodaDeAna}/guests/${creado.id}`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ dietary: 'Sin gluten', rsvp: 'DECLINED' })
        .expect(200)
    ).body as CuerpoInvitado
    expect(actualizado).toMatchObject({ dietary: 'Sin gluten', rsvp: 'DECLINED' })

    await request(url)
      .delete(`/events/${bodaDeAna}/guests/${creado.id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)

    expect(await prisma.guest.findUnique({ where: { id: creado.id } })).toBeNull()
  })

  it('un PATCH sobre un invitado inexistente responde 404', async () => {
    const respuesta = await request(url)
      .patch(`/events/${bodaDeAna}/guests/00000000-0000-4000-8000-000000000000`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ rsvp: 'CONFIRMED' })
      .expect(404)

    expect((respuesta.body as CuerpoError).code).toBe('GUEST_NOT_FOUND')
  })

  it('el envío masivo devuelve 202 y REPORTA a quién no se le manda nada', async () => {
    // Boda aparte, con los tres casos exactos: con correo, sin correo y con
    // respuesta ya dada. Así el recuento no depende de lo que hicieron los
    // tests anteriores.
    const boda = await crearEvento(ana.accessToken, 'Boda del envío')

    const conCorreo = (
      await request(url)
        .post(`/events/${boda}/guests`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ name: 'Con correo', email: 'con-correo@test.com', group: 'Friends' })
        .expect(201)
    ).body as CuerpoInvitado

    const sinCorreo = (
      await request(url)
        .post(`/events/${boda}/guests`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ name: 'Sin correo', group: 'Family' })
        .expect(201)
    ).body as CuerpoInvitado

    const yaRespondio = (
      await request(url)
        .post(`/events/${boda}/guests`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ name: 'Ya respondió', email: 'respondio@test.com', group: 'Work' })
        .expect(201)
    ).body as CuerpoInvitado
    await request(url)
      .patch(`/events/${boda}/guests/${yaRespondio.id}`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .send({ rsvp: 'CONFIRMED' })
      .expect(200)

    const respuesta = await request(url)
      .post(`/events/${boda}/guests/invitations`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(202)

    const resultado = respuesta.body as CuerpoEnvio
    expect(resultado.queued.map((q) => q.guestId)).toEqual([conCorreo.id])
    expect(resultado.skipped).toEqual(
      expect.arrayContaining([
        { guestId: sinCorreo.id, reason: 'NO_EMAIL' },
        { guestId: yaRespondio.id, reason: 'ALREADY_RESPONDED' },
      ]),
    )
    expect(resultado.skipped).toHaveLength(2)

    // La fila existe y guarda un HASH, no el token: el enlace no es
    // reconstruible desde la base de datos.
    const filas = await prisma.guestInvitation.findMany({ where: { guestId: conCorreo.id } })
    expect(filas).toHaveLength(1)
    expect(filas[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('invitar a UNO sin correo es 422 con código, no un 202 silencioso', async () => {
    const boda = await crearEvento(ana.accessToken, 'Boda del envío individual')

    const mudo = (
      await request(url)
        .post(`/events/${boda}/guests`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ name: 'Sin correo', group: 'Family' })
        .expect(201)
    ).body as CuerpoInvitado

    const respuesta = await request(url)
      .post(`/events/${boda}/guests/${mudo.id}/invitation`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(422)

    expect((respuesta.body as CuerpoError).code).toBe('GUEST_HAS_NO_EMAIL')
    expect(await prisma.guestInvitation.count({ where: { guestId: mudo.id } })).toBe(0)
  })

  it('invitar a UNO con correo es 202 y deja la invitación encolada', async () => {
    const boda = await crearEvento(ana.accessToken, 'Boda del envío individual 2')

    const invitado = (
      await request(url)
        .post(`/events/${boda}/guests`)
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .send({ name: 'Uno', email: 'uno@test.com', group: 'Friends' })
        .expect(201)
    ).body as CuerpoInvitado

    const respuesta = await request(url)
      .post(`/events/${boda}/guests/${invitado.id}/invitation`)
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(202)

    const cuerpo = respuesta.body as { guestId: string; invitationId: string }
    expect(cuerpo.guestId).toBe(invitado.id)
    const fila = await prisma.guestInvitation.findUnique({ where: { id: cuerpo.invitationId } })
    expect(fila?.guestId).toBe(invitado.id)
  })

  it('un vendor contratado NO puede tocar NINGUNA de las ocho rutas: 403', async () => {
    // Boda, invitado y vendor propios: `@RequireEventAccess` es inerte si
    // falta en un método, y un decorador que falta se ve igual que uno que
    // está. Por eso se comprueban las SEIS rutas, no sólo el listado — con
    // una sola, el día que alguien olvide el decorador en el DELETE la suite
    // seguiría verde.
    const anaEmail = `ana-${randomUUID()}@test.com`
    const fotografoEmail = `foto-${randomUUID()}@test.com`
    const anaPropia = await registrarYEntrar(anaEmail, 'Ana Propia')
    const fotografoPropio = await registrarYEntrar(fotografoEmail, 'Fotógrafo Propio')
    const bodaPropia = await crearEvento(anaPropia.accessToken, 'Boda propia')

    const victima = (
      await request(url)
        .post(`/events/${bodaPropia}/guests`)
        .set('Authorization', `Bearer ${anaPropia.accessToken}`)
        .send({ name: 'Invitado', group: 'Friends' })
        .expect(201)
    ).body as CuerpoInvitado

    const perfil = await prisma.vendorProfile.create({
      data: {
        userId: fotografoPropio.id,
        businessName: 'Lumière',
        category: 'Fotografía',
        status: 'PUBLISHED',
      },
    })
    await prisma.eventVendor.create({
      data: {
        eventId: bodaPropia,
        vendorProfileId: perfil.id,
        category: 'Fotografía',
        status: 'BOOKED',
      },
    })

    // Tiene acceso al evento: `GET /events/:id` (sin @RequireEventAccess) le
    // deja entrar. Lo que no tiene es permiso sobre los invitados.
    await request(url)
      .get(`/events/${bodaPropia}`)
      .set('Authorization', `Bearer ${fotografoPropio.accessToken}`)
      .expect(200)

    const token = `Bearer ${fotografoPropio.accessToken}`

    // Cada petición en su propio thunk para recorrerlas todas en el mismo
    // bucle de abajo: no hay carrera por el puerto, `url` ya escucha desde
    // `beforeAll` (ver `arrancarAppDeTest`, `test/support/app.ts`).
    const negados = [
      () => request(url).get(`/events/${bodaPropia}/guests`).set('Authorization', token),
      () =>
        request(url).post(`/events/${bodaPropia}/guests/invitations`).set('Authorization', token),
      () =>
        request(url)
          .post(`/events/${bodaPropia}/guests/${victima.id}/invitation`)
          .set('Authorization', token),
      () => request(url).get(`/events/${bodaPropia}/guests/summary`).set('Authorization', token),
      () =>
        request(url)
          .post(`/events/${bodaPropia}/guests`)
          .set('Authorization', token)
          .send({ name: 'Colado', group: 'Work' }),
      () =>
        request(url).get(`/events/${bodaPropia}/guests/${victima.id}`).set('Authorization', token),
      () =>
        request(url)
          .patch(`/events/${bodaPropia}/guests/${victima.id}`)
          .set('Authorization', token)
          .send({ rsvp: 'DECLINED' }),
      () =>
        request(url)
          .delete(`/events/${bodaPropia}/guests/${victima.id}`)
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
    expect(await prisma.guest.count({ where: { eventId: bodaPropia, name: 'Colado' } })).toBe(0)
    // Y que el vendor no haya conseguido encolar ni una invitación.
    expect(
      await prisma.guestInvitation.count({ where: { guest: { eventId: bodaPropia } } }),
    ).toBe(0)
  })
})

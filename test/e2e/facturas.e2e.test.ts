import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import { io, type Socket as SocketCliente } from 'socket.io-client'
import request from 'supertest'

import { categoriaId } from '../support/categorias'
import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'
import { crearEventoPublicado } from '../support/eventos'

/**
 * e2e de las facturas (spec 2026-11-11): la matriz de acceso de las rutas de
 * gastos y de `/me/vendor-payments`, y los avisos en tiempo real y en campana
 * cuando un gasto pasa a PAID. La app no tiene R2 configurado, así que el
 * archivo de factura se siembra escribiendo las columnas con Prisma y las rutas
 * que lo firman responden 503 `STORAGE_UNAVAILABLE`: lo que se prueba aquí es
 * quién llega hasta el almacén, no el almacén (eso ya lo cubren los unitarios).
 */
type Usuario = { id: string; email: string; accessToken: string }
type ErrorCuerpo = { code: string }
type PagosCuerpo = {
  events: Array<{
    eventId: string
    totalReceived: string
    payments: Array<Record<string, unknown>>
  }>
}

describe('Facturas e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient
  const abiertos: SocketCliente[] = []

  let ana: Usuario
  let lia: Usuario
  let luis: Usuario
  let dj: Usuario
  let flor: Usuario
  let marta: Usuario
  let sara: Usuario
  let pia: Usuario
  let extrano: Usuario
  let evento: string

  let gastoPagadoDj: string
  let gastoPendienteDj: string
  let gastoDeFlor: string
  let gastoConArchivo: string
  let gastoSinArchivo: string

  const auth = (u: Usuario) => ({ Authorization: `Bearer ${u.accessToken}` })

  async function registrarYEntrar(email: string, fullName: string): Promise<Usuario> {
    const registro = await request(url)
      .post('/auth/register')
      .send({ email, password: 'una-contraseña-larga', fullName })
      .expect(201)
    await prisma.user.update({ where: { email }, data: { emailVerifiedAt: new Date() } })
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

  /** La creadora invita y la persona acepta (flujo real). Devuelve el id de la membresía. */
  async function invitar(u: Usuario, role: 'COUPLE' | 'PLANNER'): Promise<string> {
    const r = await request(url)
      .post(`/events/${evento}/members`)
      .set(auth(ana))
      .send({ email: u.email, role })
      .expect(201)
    await request(url).post(`/events/${evento}/invitation/accept`).set(auth(u)).expect(200)
    return (r.body as { id: string }).id
  }

  /** Ficha de proveedor + contratación en el evento con el estado dado. */
  async function contratar(
    u: Usuario,
    nombre: string,
    status: 'BOOKED' | 'CANCELLED' | 'SHORTLISTED',
  ): Promise<string> {
    const categoryId = await categoriaId(prisma, 'music-entertainment')
    const perfil = await prisma.vendorProfile.create({
      data: { userId: u.id, businessName: nombre, categoryId, status: 'PUBLISHED' },
    })
    const ev = await prisma.eventVendor.create({
      data: { eventId: evento, vendorProfileId: perfil.id, categoryId, status },
    })
    return ev.id
  }

  async function sembrarGasto(
    eventVendorId: string,
    concepto: string,
    datos: Record<string, unknown> = {},
  ): Promise<string> {
    const g = await prisma.expense.create({
      data: {
        eventId: evento,
        eventVendorId,
        concept: concepto,
        category: 'Music',
        amount: '100.00',
        status: 'PAID',
        paidAt: new Date('2026-11-01T10:00:00.000Z'),
        createdById: ana.id,
        ...datos,
      },
    })
    return g.id
  }

  async function conectar(u: Usuario): Promise<{ socket: SocketCliente; recibidos: string[] }> {
    const socket = io(`${url}/realtime`, {
      auth: { token: u.accessToken },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    })
    abiertos.push(socket)
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('connect_error', reject)
    })
    const recibidos: string[] = []
    socket.onAny((evento: string) => {
      if (evento !== 'presence.changed') recibidos.push(evento)
    })
    return { socket, recibidos }
  }

  function esperar(socket: SocketCliente, nombre: string, ms = 10_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const reloj = setTimeout(() => reject(new Error(`no llegó ${nombre} en ${ms} ms`)), ms)
      socket.once(nombre, (datos: unknown) => {
        clearTimeout(reloj)
        resolve(datos)
      })
    })
  }

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@test.com', 'Ana')
    lia = await registrarYEntrar('lia@test.com', 'Lia')
    luis = await registrarYEntrar('luis@test.com', 'Luis')
    dj = await registrarYEntrar('dj@test.com', 'DJ')
    flor = await registrarYEntrar('flor@test.com', 'Flor')
    marta = await registrarYEntrar('marta@test.com', 'Marta')
    sara = await registrarYEntrar('sara@test.com', 'Sara')
    pia = await registrarYEntrar('pia@test.com', 'Pia')
    extrano = await registrarYEntrar('extrano@test.com', 'Extraño')

    evento = await crearEventoPublicado(url, ana.accessToken, 'Boda de Ana')

    const membresiaLia = await invitar(lia, 'COUPLE')
    await invitar(luis, 'COUPLE')
    await invitar(pia, 'PLANNER')
    await request(url)
      .patch(`/events/${evento}/members/${membresiaLia}`)
      .set(auth(ana))
      .send({ budgetAccess: 'view' })
      .expect(200)

    const evDj = await contratar(dj, 'DJ Max', 'BOOKED')
    const evFlor = await contratar(flor, 'Flor y Co', 'BOOKED')
    // Marta cobró y después se canceló su contratación.
    const evMarta = await contratar(marta, 'Marta Foto', 'CANCELLED')
    const evSara = await contratar(sara, 'Sara Video', 'SHORTLISTED')
    const evPia = await contratar(pia, 'Pía Catering', 'BOOKED')

    gastoPagadoDj = await sembrarGasto(evDj, 'DJ pagado', {
      invoiceNumber: 'DJ-1',
      notes: 'nota privada',
      dueDate: new Date('2026-10-30T00:00:00.000Z'),
    })
    gastoPendienteDj = await sembrarGasto(evDj, 'DJ pendiente', {
      status: 'PENDING',
      paidAt: null,
    })
    gastoDeFlor = await sembrarGasto(evFlor, 'Flores pagadas')
    await sembrarGasto(evMarta, 'Fotos pagadas')
    await sembrarGasto(evSara, 'Video pagado')
    await sembrarGasto(evPia, 'Catering pagado')

    gastoConArchivo = await sembrarGasto(evFlor, 'Con archivo', {
      invoiceFileKey: `events/${evento}/invoices/seed.pdf`,
      invoiceFileName: 'factura.pdf',
      invoiceFileType: 'application/pdf',
      invoiceFileBytes: 1234,
    })
    gastoSinArchivo = gastoDeFlor
  }, 180_000)

  afterAll(async () => {
    for (const s of abiertos.splice(0)) s.disconnect()
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  describe('Ana, la creadora', () => {
    it('lista gastos y ve el resumen con overdue y upcoming', async () => {
      const lista = await request(url).get(`/events/${evento}/expenses`).set(auth(ana)).expect(200)
      expect((lista.body as { items: unknown[] }).items.length).toBeGreaterThan(0)
      const resumen = await request(url)
        .get(`/events/${evento}/budget-summary`)
        .set(auth(ana))
        .expect(200)
      expect(resumen.body).toHaveProperty('overdue')
      expect(resumen.body).toHaveProperty('upcoming')
    })

    it('crea con número y subtotal (tax derivado), rechaza repetido y subtotal mayor', async () => {
      const cuerpo = {
        concept: 'Pastel',
        category: 'Food',
        amount: '121.00',
        payeeName: 'Pastelería',
        invoiceNumber: 'A-100',
        subtotal: '100.00',
      }
      const creado = await request(url)
        .post(`/events/${evento}/expenses`)
        .set(auth(ana))
        .send(cuerpo)
        .expect(201)
      expect(creado.body).toMatchObject({
        invoiceNumber: 'A-100',
        subtotal: '100.00',
        tax: '21.00',
      })

      const repetido = await request(url)
        .post(`/events/${evento}/expenses`)
        .set(auth(ana))
        .send(cuerpo)
        .expect(409)
      expect((repetido.body as ErrorCuerpo).code).toBe('INVOICE_NUMBER_TAKEN')

      await request(url)
        .post(`/events/${evento}/expenses`)
        .set(auth(ana))
        .send({ ...cuerpo, invoiceNumber: 'A-101', subtotal: '200.00' })
        .expect(422)
    })

    it('sin R2, invoice-upload-url responde 503 STORAGE_UNAVAILABLE', async () => {
      const r = await request(url)
        .post(`/events/${evento}/expenses/invoice-upload-url`)
        .set(auth(ana))
        .send({ contentType: 'application/pdf', bytes: 1000 })
        .expect(503)
      expect((r.body as ErrorCuerpo).code).toBe('STORAGE_UNAVAILABLE')
    })

    it('invoice-file de un gasto sin archivo es 404 INVOICE_FILE_NOT_FOUND', async () => {
      const r = await request(url)
        .get(`/events/${evento}/expenses/${gastoSinArchivo}/invoice-file`)
        .set(auth(ana))
        .expect(404)
      expect((r.body as ErrorCuerpo).code).toBe('INVOICE_FILE_NOT_FOUND')
    })

    it('invoice-file de un gasto con archivo llega al almacén (503 sin R2)', async () => {
      const r = await request(url)
        .get(`/events/${evento}/expenses/${gastoConArchivo}/invoice-file`)
        .set(auth(ana))
        .expect(503)
      expect((r.body as ErrorCuerpo).code).toBe('STORAGE_UNAVAILABLE')
    })
  })

  describe('Lia, COUPLE con grant', () => {
    it('lee lista, resumen e invoice-file; no escribe ni pide subida', async () => {
      await request(url).get(`/events/${evento}/expenses`).set(auth(lia)).expect(200)
      await request(url).get(`/events/${evento}/budget-summary`).set(auth(lia)).expect(200)
      // Pasa el control de acceso y sólo se detiene en el almacén.
      await request(url)
        .get(`/events/${evento}/expenses/${gastoConArchivo}/invoice-file`)
        .set(auth(lia))
        .expect(503)
      await request(url)
        .get(`/events/${evento}/expenses/${gastoSinArchivo}/invoice-file`)
        .set(auth(lia))
        .expect(404)
      await request(url)
        .post(`/events/${evento}/expenses`)
        .set(auth(lia))
        .send({ concept: 'X', category: 'Y', amount: '1', payeeName: 'Z' })
        .expect(403)
      await request(url)
        .post(`/events/${evento}/expenses/invoice-upload-url`)
        .set(auth(lia))
        .send({ contentType: 'application/pdf', bytes: 1000 })
        .expect(403)
    })
  })

  describe('Luis, COUPLE sin grant', () => {
    it('recibe 403 en las rutas de evento y no tiene pagos como proveedor', async () => {
      await request(url).get(`/events/${evento}/expenses`).set(auth(luis)).expect(403)
      await request(url).get(`/events/${evento}/budget-summary`).set(auth(luis)).expect(403)
      await request(url)
        .get(`/events/${evento}/expenses/${gastoConArchivo}/invoice-file`)
        .set(auth(luis))
        .expect(403)
      const r = await request(url).get('/me/vendor-payments').set(auth(luis)).expect(200)
      expect(r.body).toEqual({ events: [] })
    })
  })

  describe('DJ, proveedor BOOKED', () => {
    it('recibe 403 en las rutas de evento de gastos', async () => {
      await request(url).get(`/events/${evento}/expenses`).set(auth(dj)).expect(403)
      await request(url).get(`/events/${evento}/budget-summary`).set(auth(dj)).expect(403)
    })

    it('sólo ve su pago PAID, con las claves exactas', async () => {
      const r = await request(url).get('/me/vendor-payments').set(auth(dj)).expect(200)
      const cuerpo = r.body as PagosCuerpo
      expect(cuerpo.events).toHaveLength(1)
      const pagos = cuerpo.events[0]?.payments ?? []
      expect(pagos).toHaveLength(1)
      expect(pagos[0]).toMatchObject({ id: gastoPagadoDj, invoiceNumber: 'DJ-1' })
      expect(Object.keys(pagos[0] ?? {}).sort()).toEqual([
        'amount',
        'concept',
        'id',
        'invoiceFile',
        'invoiceNumber',
        'paidAt',
        'subtotal',
        'tax',
      ])
      expect(JSON.stringify(cuerpo)).not.toContain('nota privada')
    })

    it('el pago de otro proveedor es 404 VENDOR_PAYMENT_NOT_FOUND', async () => {
      const r = await request(url)
        .get(`/me/vendor-payments/${gastoDeFlor}/invoice-file`)
        .set(auth(dj))
        .expect(404)
      expect((r.body as ErrorCuerpo).code).toBe('VENDOR_PAYMENT_NOT_FOUND')
    })
  })

  describe('Marta, contratación CANCELLED tras cobrar', () => {
    it('conserva su pago pero ya no ve el evento', async () => {
      const r = await request(url).get('/me/vendor-payments').set(auth(marta)).expect(200)
      const cuerpo = r.body as PagosCuerpo
      expect(cuerpo.events).toHaveLength(1)
      expect(cuerpo.events[0]?.payments).toHaveLength(1)
      await request(url).get(`/events/${evento}`).set(auth(marta)).expect(404)
      await request(url).get(`/events/${evento}/expenses`).set(auth(marta)).expect(404)
    })
  })

  describe('Sara, SHORTLISTED', () => {
    it('no recibe pagos', async () => {
      const r = await request(url).get('/me/vendor-payments').set(auth(sara)).expect(200)
      expect(r.body).toEqual({ events: [] })
    })
  })

  describe('Pía, PLANNER y además proveedora BOOKED', () => {
    it('ve su pago como proveedora pero no el presupuesto sin grant', async () => {
      const r = await request(url).get('/me/vendor-payments').set(auth(pia)).expect(200)
      const cuerpo = r.body as PagosCuerpo
      expect(cuerpo.events).toHaveLength(1)
      expect(cuerpo.events[0]?.payments).toHaveLength(1)
      await request(url).get(`/events/${evento}/expenses`).set(auth(pia)).expect(403)
      await request(url).get(`/events/${evento}/budget-summary`).set(auth(pia)).expect(403)
    })
  })

  describe('El extraño', () => {
    it('recibe 404 en las rutas de evento y no tiene pagos', async () => {
      await request(url).get(`/events/${evento}/expenses`).set(auth(extrano)).expect(404)
      await request(url).get(`/events/${evento}/budget-summary`).set(auth(extrano)).expect(404)
      await request(url)
        .get(`/events/${evento}/expenses/${gastoConArchivo}/invoice-file`)
        .set(auth(extrano))
        .expect(404)
      await request(url)
        .post(`/events/${evento}/expenses/invoice-upload-url`)
        .set(auth(extrano))
        .send({ contentType: 'application/pdf', bytes: 1000 })
        .expect(404)
      const r = await request(url).get('/me/vendor-payments').set(auth(extrano)).expect(200)
      expect(r.body).toEqual({ events: [] })
    })
  })

  describe('Avisos al pasar un gasto a PAID', () => {
    it('avisa al proveedor y a quien ve el presupuesto, y a nadie más', async () => {
      const deDj = await conectar(dj)
      const deLia = await conectar(lia)
      const deLuis = await conectar(luis)

      const cambioProveedor = esperar(deDj.socket, 'vendor-payment.changed')
      const campanaProveedor = esperar(deDj.socket, 'notification.created')
      const cambioPresupuesto = esperar(deLia.socket, 'expense.changed')

      await request(url)
        .patch(`/events/${evento}/expenses/${gastoPendienteDj}`)
        .set(auth(ana))
        .send({ status: 'PAID' })
        .expect(200)

      expect(await cambioProveedor).toEqual({ eventId: evento })
      await campanaProveedor
      expect(await cambioPresupuesto).toEqual({ eventId: evento })

      const campana = await request(url).get('/me/notifications').set(auth(dj)).expect(200)
      const avisos = (campana.body as { items: Array<{ type: string; payload: unknown }> }).items
      const pagado = avisos.filter((n) => n.type === 'expense.paid')
      expect(pagado).toHaveLength(1)
      expect(pagado[0]?.payload).toMatchObject({
        expenseId: gastoPendienteDj,
        concept: 'DJ pendiente',
      })

      // Los emisores van tras el commit; margen para que un aviso indebido a
      // Luis llegara si existiera (control negativo).
      await new Promise((r) => setTimeout(r, 500))
      expect(deLuis.recibidos).toEqual([])
    })
  })
})

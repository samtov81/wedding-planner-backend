import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { categoriaId } from '../support/categorias'
import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'

interface Ficha {
  id: string
  status: string
  businessName: string
  priceFrom: string | null
  weddingsCount: number
  location: { address: string; lat: number; lng: number } | null
  packages: Array<{ name: string; price: string }>
  portfolio: Array<{ id: string; alt: string; url: string | null }>
}

/**
 * Perfil personal y modo proveedor. Sin R2 configurado (como en local sin
 * credenciales): subir fotos responde 503 y el resto funciona. Las fotos se
 * siembran en la base para comprobar cómo salen sin almacenamiento.
 */
describe('Perfil de usuario y modo proveedor e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let beto: { id: string; accessToken: string }

  async function registrarYEntrar(email: string, fullName: string) {
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
      accessToken: (login.body as { accessToken: string }).accessToken,
    }
  }

  const comoAna = (r: request.Test) => r.set('Authorization', `Bearer ${ana.accessToken}`)

  beforeAll(async () => {
    pg = await startPostgres()
    redis = await new RedisContainer('redis:7-alpine').start()
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() })
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    ana = await registrarYEntrar('ana@perfil.test', 'Ana')
    beto = await registrarYEntrar('beto@perfil.test', 'Beto')
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  describe('perfil personal', () => {
    it('sin sesión → 401', async () => {
      await request(url).get('/users/me/profile').expect(401)
    })

    it('todo usuario registrado tiene perfil, sin avatar al empezar', async () => {
      const res = await comoAna(request(url).get('/users/me/profile')).expect(200)
      expect(res.body).toEqual({
        id: ana.id,
        email: 'ana@perfil.test',
        fullName: 'Ana',
        avatarUrl: null,
      })
    })

    it('cambia el nombre; el email no se puede cambiar', async () => {
      const res = await comoAna(request(url).patch('/users/me/profile'))
        .send({ fullName: 'Ana María' })
        .expect(200)
      expect((res.body as { fullName: string }).fullName).toBe('Ana María')
      await comoAna(request(url).patch('/users/me/profile'))
        .send({ fullName: 'Ana', email: 'otro@perfil.test' })
        .expect(400)
    })

    it('sin R2, subir avatar responde 503', async () => {
      const res = await comoAna(request(url).post('/users/me/avatar/upload-url'))
        .send({ contentType: 'image/png', size: 1000 })
        .expect(503)
      expect((res.body as { code: string }).code).toBe('STORAGE_UNAVAILABLE')
    })
  })

  describe('modo proveedor', () => {
    it('empieza apagado: no hay ficha', async () => {
      await comoAna(request(url).get('/users/me/vendor-profile')).expect(404)
      await comoAna(request(url).put('/users/me/vendor-profile/status'))
        .send({ active: true })
        .expect(404)
    })

    it('nombre y categoría son obligatorios', async () => {
      await comoAna(request(url).put('/users/me/vendor-profile'))
        .send({ businessName: '', category: 'photography' })
        .expect(400)
    })

    it('guardar crea la ficha oculta; el switch la publica en el catálogo y la ficha pública', async () => {
      const guardada = await comoAna(request(url).put('/users/me/vendor-profile'))
        .send({
          businessName: 'Aurelia Luxe',
          category: 'photography',
          tagline: 'Luxury Destination Photography',
          yearsExperience: 12,
          responseTime: '< 2h',
          currency: 'EUR',
          publications: ['VOGUE'],
          contact: { email: 'hola@aurelia.test', phone: '', website: 'www.aurelia.test' },
          location: { address: 'Paris, France', lat: 48.8566, lng: 2.3522 },
        })
        .expect(200)
      const ficha = guardada.body as Ficha
      expect(ficha.status).toBe('DRAFT')
      expect((guardada.body as { category: unknown }).category).toEqual({
        slug: 'photography',
        name: 'Photography',
      })
      expect(ficha.location).toMatchObject({ address: 'Paris, France', lat: 48.8566 })

      await request(url).get(`/vendors/${ficha.id}`).expect(404)

      const publicada = await comoAna(request(url).put('/users/me/vendor-profile/status'))
        .send({ active: true })
        .expect(200)
      expect((publicada.body as Ficha).status).toBe('PUBLISHED')

      const catalogo = await request(url)
        .get('/vendors?q=aurelia')
        .set('Authorization', `Bearer ${beto.accessToken}`)
        .expect(200)
      expect((catalogo.body as { items: unknown[] }).items).toHaveLength(1)

      // Sin sesión, y sin exponer quién es el dueño.
      const publica = await request(url).get(`/vendors/${ficha.id}`).expect(200)
      expect(publica.body).toMatchObject({
        businessName: 'Aurelia Luxe',
        currency: 'EUR',
        contact: { email: 'hola@aurelia.test', phone: null, website: 'www.aurelia.test' },
        similar: [],
      })
      expect(publica.body).not.toHaveProperty('status')
      expect(publica.body).not.toHaveProperty('userId')
      expect(JSON.stringify(publica.body)).not.toContain('ana@perfil.test')

      await comoAna(request(url).put('/users/me/vendor-profile/status'))
        .send({ active: false })
        .expect(200)
      await request(url).get(`/vendors/${ficha.id}`).expect(404)
    })

    it('paquetes: precio positivo, orden y "Pricing From"', async () => {
      await comoAna(request(url).put('/users/me/vendor-profile/packages'))
        .send({ packages: [{ name: 'Gratis', description: 'x', price: 0 }] })
        .expect(400)
      const res = await comoAna(request(url).put('/users/me/vendor-profile/packages'))
        .send({
          packages: [
            { name: 'Signature', description: 'Todo el día', price: '7200' },
            { name: 'Essentials', description: '6 horas', price: 4500 },
          ],
        })
        .expect(200)
      const ficha = res.body as Ficha
      expect(ficha.packages.map((p) => p.price)).toEqual(['7200.00', '4500.00'])
      expect(ficha.priceFrom).toBe('4500.00')
    })

    it('portfolio sin R2: subir es 503 y las fotos guardadas salen sin URL', async () => {
      await comoAna(request(url).post('/users/me/vendor-profile/portfolio/upload-url'))
        .send({ contentType: 'image/jpeg', size: 1000 })
        .expect(503)
      const ficha = await prisma.vendorProfile.findUniqueOrThrow({ where: { userId: ana.id } })
      await prisma.vendorPortfolioImage.create({
        data: {
          vendorProfileId: ficha.id,
          storageKey: `users/${ana.id}/portfolio/a.jpg`,
          alt: 'Ceremonia',
          position: 0,
        },
      })

      const res = await comoAna(request(url).get('/users/me/vendor-profile')).expect(200)
      expect((res.body as Ficha).portfolio).toEqual([
        { id: expect.any(String) as string, alt: 'Ceremonia', url: null },
      ])
    })

    it('las fotos de otro no se tocan: 404', async () => {
      const [foto] = (
        (await comoAna(request(url).get('/users/me/vendor-profile')).expect(200)).body as Ficha
      ).portfolio
      await request(url)
        .delete(`/users/me/vendor-profile/portfolio/${foto?.id ?? ''}`)
        .set('Authorization', `Bearer ${beto.accessToken}`)
        .expect(404)
      await comoAna(request(url).delete('/users/me/vendor-profile/portfolio/no-es-uuid')).expect(
        404,
      )
    })

    it('una ficha suspendida no se mueve con el switch', async () => {
      await request(url)
        .put('/users/me/vendor-profile')
        .set('Authorization', `Bearer ${beto.accessToken}`)
        .send({ businessName: 'Beto Flores', category: 'decor-floral' })
        .expect(200)
      await prisma.vendorProfile.update({
        where: { userId: beto.id },
        data: { status: 'SUSPENDED' },
      })
      await request(url)
        .put('/users/me/vendor-profile/status')
        .set('Authorization', `Bearer ${beto.accessToken}`)
        .send({ active: true })
        .expect(409)
    })

    it('la ficha pública cuenta bodas BOOKED y sugiere similares publicados', async () => {
      const aurelia = await prisma.vendorProfile.findUniqueOrThrow({ where: { userId: ana.id } })
      await prisma.vendorProfile.update({
        where: { id: aurelia.id },
        data: { status: 'PUBLISHED' },
      })
      const otro = await prisma.user.create({
        data: { email: 'maison@perfil.test', passwordHash: 'x', fullName: 'M' },
      })
      await prisma.vendorProfile.create({
        data: {
          userId: otro.id,
          businessName: 'Maison',
          categoryId: await categoriaId(prisma, 'photography'),
          status: 'PUBLISHED',
        },
      })
      const evento = await prisma.event.create({ data: { name: 'Boda', ownerId: beto.id } })
      await prisma.eventVendor.create({
        data: {
          eventId: evento.id,
          vendorProfileId: aurelia.id,
          categoryId: await categoriaId(prisma, 'photography'),
          status: 'BOOKED',
        },
      })

      const res = await request(url).get(`/vendors/${aurelia.id}`).expect(200)
      const publica = res.body as Ficha & { similar: Array<{ businessName: string }> }
      expect(publica.weddingsCount).toBe(1)
      expect((res.body as { avatarUrl: unknown }).avatarUrl).toBeNull()
      expect(publica.similar.map((s) => s.businessName)).toEqual(['Maison'])
    })
  })
})

import { PrismaClient } from '@prisma/client'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'
import request from 'supertest'

import { categoriaId } from '../support/categorias'
import { arrancarAppDeTest, fijarEntorno } from '../support/app'
import { startPostgres, type PostgresDeTest } from '../support/containers'

interface CuerpoCatalogo {
  items: Array<{
    id: string
    businessName: string
    category: { slug: string; name: string }
    specialty: string | null
    currency: string
    priceFrom: string | null
    imageUrl: string | null
  }>
  nextCursor: string | null
}

/**
 * R2 "de pega": firmar una URL de lectura es local (SigV4, sin red), así que
 * con las cuatro variables puestas la app usa `R2ObjectStorage` de verdad y
 * el e2e ve la URL firmada sin tocar ningún bucket. Cada fichero de test corre
 * en su propio proceso: esto no se filtra a `profile.e2e.test.ts`, que prueba
 * justo el caso sin R2.
 */
const R2_DE_PEGA = {
  R2_ENDPOINT: 'https://cuenta.r2.cloudflarestorage.com',
  R2_ACCESS_KEY_ID: 'id',
  R2_SECRET_ACCESS_KEY: 'secreto',
  R2_BUCKET: 'fotos',
}

/**
 * `GET /vendors` es el catálogo público del marketplace (Tarea 10): cualquier
 * usuario con sesión puede buscarlo, no hace falta pertenecer a un evento.
 */
describe('Catálogo de proveedores e2e', () => {
  let pg: PostgresDeTest
  let redis: StartedRedisContainer
  let url: string
  let cerrar: () => Promise<void>
  let prisma: PrismaClient

  let ana: { id: string; accessToken: string }
  let lumiereUserId: string
  let lumiereId: string
  let jardinId: string

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
    fijarEntorno({ databaseUrl: pg.url, redisUrl: redis.getConnectionUrl() }, R2_DE_PEGA)
    ;({ url, cerrar } = await arrancarAppDeTest())
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    ana = await registrarYEntrar('ana@catalogo.test', 'Ana')

    const publicado = await prisma.user.create({
      data: { email: 'lumiere@catalogo.test', passwordHash: 'x', fullName: 'Lumière' },
    })
    lumiereUserId = publicado.id
    const lumiere = await prisma.vendorProfile.create({
      data: {
        userId: publicado.id,
        businessName: 'Lumière',
        categoryId: await categoriaId(prisma, 'catering'),
        status: 'PUBLISHED',
        currency: 'EUR',
      },
    })
    lumiereId = lumiere.id
    await prisma.vendorPackage.createMany({
      data: [
        {
          vendorProfileId: lumiere.id,
          name: 'Completo',
          description: 'Todo incluido',
          price: '4500.00',
          position: 0,
        },
        {
          vendorProfileId: lumiere.id,
          name: 'Básico',
          description: 'Lo esencial',
          price: '1200.50',
          position: 1,
        },
      ],
    })
    await prisma.vendorPortfolioImage.create({
      data: {
        vendorProfileId: lumiere.id,
        storageKey: `users/${publicado.id}/portfolio/a.jpg`,
        alt: 'Mesa',
        position: 0,
      },
    })

    // Publicada, sin paquetes ni fotos; en `venue` para no tocar los filtros de abajo.
    const vacio = await prisma.user.create({
      data: { email: 'jardin@catalogo.test', passwordHash: 'x', fullName: 'Jardín' },
    })
    const jardin = await prisma.vendorProfile.create({
      data: {
        userId: vacio.id,
        businessName: 'Jardín Vacío',
        categoryId: await categoriaId(prisma, 'venue'),
        status: 'PUBLISHED',
      },
    })
    jardinId = jardin.id

    const oculto = await prisma.user.create({
      data: { email: 'oculto@catalogo.test', passwordHash: 'x', fullName: 'Oculto' },
    })
    await prisma.vendorProfile.create({
      data: {
        userId: oculto.id,
        businessName: 'Oculto',
        categoryId: await categoriaId(prisma, 'catering'),
        status: 'DRAFT',
      },
    })
  }, 180_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await cerrar()
    await redis.stop()
    await pg.stop()
  }, 60_000)

  it('sin sesión → 401', async () => {
    await request(url).get('/vendors').expect(401)
  })

  it('lista solo perfiles PUBLISHED y filtra por q', async () => {
    const res = await request(url)
      .get('/vendors?q=lumi')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    const cuerpo = res.body as CuerpoCatalogo
    expect(cuerpo.nextCursor).toBeNull()
    expect(cuerpo.items).toHaveLength(1)
    expect(cuerpo.items[0]).toMatchObject({
      businessName: 'Lumière',
      category: { slug: 'catering', name: 'Catering' },
      specialty: null,
    })
  })

  it('cada ítem trae currency, priceFrom e imageUrl; sin paquetes ni fotos, null', async () => {
    const res = await request(url)
      .get('/vendors')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    const cuerpo = res.body as CuerpoCatalogo

    expect(cuerpo.nextCursor).toBeNull()
    // `toEqual` exacto: ni `imageKey` ni `createdAt` salen en la respuesta.
    expect(cuerpo.items).toEqual([
      {
        id: lumiereId,
        businessName: 'Lumière',
        category: { slug: 'catering', name: 'Catering' },
        specialty: null,
        currency: 'EUR',
        priceFrom: '1200.50',
        imageUrl: expect.any(String) as string,
      },
      {
        id: jardinId,
        businessName: 'Jardín Vacío',
        category: { slug: 'venue', name: 'Venue' },
        specialty: null,
        currency: 'USD',
        priceFrom: null,
        imageUrl: null,
      },
    ])
    const imageUrl = cuerpo.items[0]?.imageUrl ?? ''
    expect(imageUrl).toContain(`/users/${lumiereUserId}/portfolio/a.jpg?`)
    expect(imageUrl).toContain('X-Amz-Signature=')
  })

  it('cursor inválido → 400 y limit fuera de rango → 400', async () => {
    await request(url)
      .get('/vendors?cursor=basura')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(400)
    await request(url)
      .get('/vendors?limit=500')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(400)
  })

  it('filtra por el slug de la categoría', async () => {
    const porSlug = await request(url)
      .get('/vendors?category=catering')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    expect((porSlug.body as CuerpoCatalogo).items.map((i) => i.businessName)).toEqual(['Lumière'])

    const otra = await request(url)
      .get('/vendors?category=photography')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(200)
    expect((otra.body as CuerpoCatalogo).items).toEqual([])

    await request(url)
      .get('/vendors?category=Catering')
      .set('Authorization', `Bearer ${ana.accessToken}`)
      .expect(400)
  })

  describe('GET /vendor-categories', () => {
    it('sin sesión → 401', async () => {
      await request(url).get('/vendor-categories').expect(401)
    })

    it('lista las categorías activas en su orden, con slug y nombre', async () => {
      const res = await request(url)
        .get('/vendor-categories')
        .set('Authorization', `Bearer ${ana.accessToken}`)
        .expect(200)

      expect(res.body).toEqual({
        items: [
          { slug: 'venue', name: 'Venue' },
          { slug: 'catering', name: 'Catering' },
          { slug: 'photography', name: 'Photography' },
          { slug: 'decor-floral', name: 'Decor & Floral' },
          { slug: 'music-entertainment', name: 'Music & Entertainment' },
          { slug: 'attire-beauty', name: 'Attire & Beauty' },
          { slug: 'stationery', name: 'Stationery' },
          { slug: 'media', name: 'Media' },
        ],
      })
    })
  })
})

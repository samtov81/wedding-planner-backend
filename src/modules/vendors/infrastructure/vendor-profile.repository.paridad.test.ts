import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { VendorProfileRepository } from '../application/vendor-profile.repository'
import type { DatosDeFicha, FichaDeProveedor } from '../domain/vendor-profile'
import { PrismaVendorProfileRepository } from './prisma-vendor-profile.repository'
import { VendorProfileRepositoryEnMemoria } from './vendor-profile.repository.fake'

const DATOS: DatosDeFicha = {
  businessName: 'Aurelia Luxe',
  category: 'Photography',
  specialty: 'Destination',
  tagline: 'Luxury Destination Photography',
  bio: 'Fotografía de bodas',
  quote: 'Capturing timeless elegance',
  yearsExperience: 12,
  responseTime: '< 2h',
  currency: 'EUR',
  publications: ['VOGUE', 'BRIDES'],
  contact: { email: 'hola@aurelia.test', phone: '+33 1 23', website: 'www.aurelia.test' },
  location: {
    name: 'Studio',
    address: 'Paris, France',
    lat: 48.8566,
    lng: 2.3522,
    mapboxId: 'mb1',
  },
}

/** Sin ids: lo único que cambia entre el doble y Postgres. */
function sinIds(ficha: FichaDeProveedor | null) {
  if (ficha === null) return null
  return {
    ...ficha,
    id: 'x',
    packages: ficha.packages.map((p) => ({ ...p, id: 'x' })),
    portfolio: ficha.portfolio.map((f) => ({ ...f, id: 'x' })),
  }
}

describe('Paridad: VendorProfileRepositoryEnMemoria vs PrismaVendorProfileRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let usuarios: string[]

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    usuarios = await Promise.all(
      ['a', 'b', 'c', 'd'].map(async (n) => {
        const u = await prisma.user.create({
          data: { email: `${n}@paridad-ficha.test`, passwordHash: 'x', fullName: n },
        })
        return u.id
      }),
    )
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function sujetos(): Array<[string, VendorProfileRepository]> {
    return [
      ['doble', new VendorProfileRepositoryEnMemoria()],
      ['prisma', new PrismaVendorProfileRepository(prisma as unknown as PrismaService)],
    ]
  }

  async function limpiar(): Promise<void> {
    await prisma.vendorProfile.deleteMany({})
  }

  function usuario(i: number): string {
    const id = usuarios[i]
    if (id === undefined) throw new Error('sin usuario')
    return id
  }

  it('alta en DRAFT, edición y lectura con todos los campos', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      await limpiar()
      expect(await repo.buscarPorUsuario(usuario(0))).toBeNull()
      await repo.guardarDatos(usuario(0), { ...DATOS, tagline: null })
      const editada = await repo.guardarDatos(usuario(0), DATOS)
      resultados.push({
        editada: sinIds(editada),
        leida: sinIds(await repo.buscarPorUsuario(usuario(0))),
      })
    }
    expect(resultados[0]?.editada).toMatchObject({ ...DATOS, status: 'DRAFT', avatarKey: null })
    expect(resultados[0]?.leida).toEqual(resultados[0]?.editada)
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('sin ubicación ni contacto se leen vacíos', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      await limpiar()
      resultados.push(
        sinIds(
          await repo.guardarDatos(usuario(0), {
            ...DATOS,
            location: null,
            contact: { email: null, phone: null, website: null },
          }),
        ),
      )
    }
    expect(resultados[0]?.location).toBeNull()
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('el estado decide la visibilidad pública', async () => {
    for (const [nombre, repo] of sujetos()) {
      await limpiar()
      const ficha = await repo.guardarDatos(usuario(0), DATOS)
      expect(await repo.buscarPublicada(ficha.id), nombre).toBeNull()
      await repo.fijarEstado(ficha.id, 'PUBLISHED')
      expect((await repo.buscarPublicada(ficha.id))?.status, nombre).toBe('PUBLISHED')
      await repo.fijarEstado(ficha.id, 'DRAFT')
      expect(await repo.buscarPublicada(ficha.id), nombre).toBeNull()
    }
  })

  it('reemplaza paquetes en orden', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      await limpiar()
      const ficha = await repo.guardarDatos(usuario(0), DATOS)
      await repo.reemplazarPaquetes(ficha.id, [
        { name: 'Uno', description: 'd1', price: '100.00' },
        { name: 'Dos', description: 'd2', price: '50.50' },
      ])
      await repo.reemplazarPaquetes(ficha.id, [
        { name: 'Tres', description: 'd3', price: '7200.00' },
        { name: 'Cuatro', description: 'd4', price: '4500.00' },
      ])
      resultados.push(sinIds(await repo.buscarPorUsuario(usuario(0)))?.packages)
    }
    expect(resultados[0]).toEqual([
      { id: 'x', name: 'Tres', description: 'd3', price: '7200.00' },
      { id: 'x', name: 'Cuatro', description: 'd4', price: '4500.00' },
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('fotos: añade al final, describe, reordena y borra sólo las propias', async () => {
    const resultados = []
    for (const [nombre, repo] of sujetos()) {
      await limpiar()
      const ficha = await repo.guardarDatos(usuario(0), DATOS)
      const ajena = await repo.guardarDatos(usuario(1), DATOS)
      const a = await repo.agregarFoto(ficha.id, { storageKey: `${nombre}/a.jpg`, alt: 'A' })
      const b = await repo.agregarFoto(ficha.id, { storageKey: `${nombre}/b.jpg`, alt: 'B' })
      const c = await repo.agregarFoto(ficha.id, { storageKey: `${nombre}/c.jpg`, alt: 'C' })

      expect(await repo.cambiarAlt(ajena.id, a.id, 'robada'), nombre).toBe(false)
      expect(await repo.cambiarAlt(ficha.id, a.id, 'Ceremonia'), nombre).toBe(true)
      await repo.reordenarFotos(ficha.id, [c.id, a.id, b.id])
      expect(await repo.borrarFoto(ajena.id, b.id), nombre).toBeNull()
      expect(await repo.borrarFoto(ficha.id, b.id), nombre).toBe(`${nombre}/b.jpg`)
      const d = await repo.agregarFoto(ficha.id, { storageKey: `${nombre}/d.jpg`, alt: 'D' })

      const fotos = (await repo.buscarPorUsuario(usuario(0)))?.portfolio ?? []
      expect(
        fotos.map((f) => f.id),
        nombre,
      ).toEqual([c.id, a.id, d.id])
      resultados.push(fotos.map((f) => [f.storageKey.replace(`${nombre}/`, ''), f.alt]))
    }
    expect(resultados[0]).toEqual([
      ['c.jpg', 'C'],
      ['a.jpg', 'Ceremonia'],
      ['d.jpg', 'D'],
    ])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('similares: publicadas, misma categoría sin distinguir mayúsculas, sin ella misma', async () => {
    const resultados = []
    for (const [, repo] of sujetos()) {
      await limpiar()
      const propia = await repo.guardarDatos(usuario(0), DATOS)
      const par = await repo.guardarDatos(usuario(1), {
        ...DATOS,
        businessName: 'Maison',
        category: 'PHOTOGRAPHY',
      })
      await repo.guardarDatos(usuario(2), { ...DATOS, businessName: 'Borrador' })
      const otra = await repo.guardarDatos(usuario(3), {
        ...DATOS,
        businessName: 'Flores',
        category: 'Floral',
      })
      for (const f of [propia, par, otra]) await repo.fijarEstado(f.id, 'PUBLISHED')

      resultados.push((await repo.similares(propia, 4)).map((f) => f.businessName))
    }
    expect(resultados[0]).toEqual(['Maison'])
    expect(resultados[1]).toEqual(resultados[0])
  })

  it('Postgres: cuenta bodas por evento distinto y sólo BOOKED', async () => {
    await limpiar()
    const repo = new PrismaVendorProfileRepository(prisma as unknown as PrismaService)
    const ficha = await repo.guardarDatos(usuario(0), DATOS)
    const [e1, e2] = await Promise.all(
      ['E1', 'E2'].map((name) => prisma.event.create({ data: { name, ownerId: usuario(1) } })),
    )
    if (e1 === undefined || e2 === undefined) throw new Error('sin eventos')
    await prisma.eventVendor.createMany({
      data: [
        { eventId: e1.id, vendorProfileId: ficha.id, category: 'Photo', status: 'BOOKED' },
        { eventId: e2.id, vendorProfileId: ficha.id, category: 'Photo', status: 'SHORTLISTED' },
      ],
    })

    expect(await repo.contarBodas(ficha.id)).toBe(1)
    await prisma.eventVendor.deleteMany({})
    await prisma.event.deleteMany({})
  })
})

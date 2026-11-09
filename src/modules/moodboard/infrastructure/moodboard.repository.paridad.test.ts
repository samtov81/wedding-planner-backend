import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { MoodboardRepository } from '../application/moodboard.repository'
import type { Visor } from '../domain/moodboard'
import { MoodboardRepositoryFake } from './moodboard.repository.fake'
import { PrismaMoodboardRepository } from './prisma-moodboard.repository'

type EstadoEvento = 'DRAFT' | 'ACTIVE'
type EstadoContratacion = 'SHORTLISTED' | 'BOOKED' | 'CANCELLED'

/**
 * Lo que un test necesita sembrar, igual para el doble (que lo guarda en
 * memoria) y para Postgres (que lo escribe en las tablas de otros módulos).
 */
interface Mundo {
  repo: MoodboardRepository
  evento(status: EstadoEvento): Promise<string>
  cambiarEvento(eventId: string, status: EstadoEvento): Promise<void>
  categoria(active?: boolean): Promise<string>
  /** Usuario con ficha de proveedor (la `userId` de sus contrataciones). */
  proveedor(nombre: string): Promise<string>
  usuario(nombre: string): Promise<string>
  contratacion(datos: {
    eventId: string
    userId: string | null
    name: string
    status: EstadoContratacion
  }): Promise<string>
  cambiarContratacion(id: string, status: EstadoContratacion): Promise<void>
}

const pausa = () => new Promise((r) => setTimeout(r, 5))

describe('Paridad: MoodboardRepositoryFake vs PrismaMoodboardRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function mundoDoble(): Mundo {
    const repo = new MoodboardRepositoryFake()
    const contrataciones = new Map<string, Parameters<Mundo['contratacion']>[0]>()
    const categorias = new Map<string, string>()
    return {
      repo,
      evento: (status) => {
        const id = randomUUID()
        repo.sembrarEvento(id, { status })
        return Promise.resolve(id)
      },
      cambiarEvento: (id, status) => {
        repo.sembrarEvento(id, { status })
        return Promise.resolve()
      },
      categoria: (active = true) => {
        const id = randomUUID()
        categorias.set(id, 'Floristería')
        repo.sembrarCategoria({ id, slug: `cat-${id}`, name: 'Floristería', active })
        return Promise.resolve(id)
      },
      proveedor: (nombre) => {
        const id = randomUUID()
        repo.sembrarUsuario({ id, name: nombre })
        return Promise.resolve(id)
      },
      usuario: (nombre) => {
        const id = randomUUID()
        repo.sembrarUsuario({ id, name: nombre })
        return Promise.resolve(id)
      },
      contratacion: (datos) => {
        const id = randomUUID()
        contrataciones.set(id, datos)
        repo.sembrarContratacion({ id, categoryName: 'Floristería', ...datos })
        return Promise.resolve(id)
      },
      cambiarContratacion: (id, status) => {
        const previa = contrataciones.get(id)
        if (previa === undefined) throw new Error('contratación desconocida')
        repo.sembrarContratacion({ id, categoryName: 'Floristería', ...previa, status })
        return Promise.resolve()
      },
    }
  }

  function mundoPrisma(): Mundo {
    const repo = new PrismaMoodboardRepository(prisma as unknown as PrismaService)
    const creada = new Map<string, string>()
    let categoriaVigente = ''
    return {
      repo,
      evento: async (status) => {
        const owner = await prisma.user.create({
          data: {
            email: `${randomUUID()}@par-moodboard.test`,
            passwordHash: 'x',
            fullName: 'Owner',
          },
        })
        const e = await prisma.event.create({
          data: { name: 'Boda', ownerId: owner.id, status, weddingDate: new Date('2027-06-12') },
        })
        return e.id
      },
      cambiarEvento: async (id, status) => {
        await prisma.event.update({ where: { id }, data: { status } })
      },
      categoria: async (active = true) => {
        const id = randomUUID()
        const c = await prisma.vendorCategory.create({
          data: { id, slug: `cat-${id}`, name: `Cat ${id}`, position: 1, active },
        })
        categoriaVigente = c.id
        return c.id
      },
      proveedor: async (nombre) => {
        const u = await prisma.user.create({
          data: {
            email: `${randomUUID()}@par-moodboard.test`,
            passwordHash: 'x',
            fullName: nombre,
          },
        })
        const categoria =
          categoriaVigente !== ''
            ? categoriaVigente
            : (await prisma.vendorCategory.findFirstOrThrow()).id
        const perfil = await prisma.vendorProfile.create({
          data: { userId: u.id, businessName: nombre, categoryId: categoria },
        })
        creada.set(u.id, perfil.id)
        return u.id
      },
      usuario: async (nombre) => {
        const u = await prisma.user.create({
          data: {
            email: `${randomUUID()}@par-moodboard.test`,
            passwordHash: 'x',
            fullName: nombre,
          },
        })
        return u.id
      },
      contratacion: async (datos) => {
        const perfil = datos.userId === null ? undefined : creada.get(datos.userId)
        const e = await prisma.eventVendor.create({
          data: {
            eventId: datos.eventId,
            categoryId: categoriaVigente,
            status: datos.status,
            ...(perfil === undefined ? { externalName: datos.name } : { vendorProfileId: perfil }),
          },
        })
        return e.id
      },
      cambiarContratacion: async (id, status) => {
        await prisma.eventVendor.update({ where: { id }, data: { status } })
      },
    }
  }

  /** Los dos sujetos, cada uno con su propio mundo sembrado por `preparar`. */
  async function conAmbos<T>(
    preparar: (m: Mundo) => Promise<T>,
    caso: (m: Mundo, datos: T, nombre: string) => Promise<void>,
  ): Promise<void> {
    for (const [nombre, m] of [
      ['doble', mundoDoble()],
      ['prisma', mundoPrisma()],
    ] as const) {
      await caso(m, await preparar(m), nombre)
    }
  }

  const sinVolatiles = ({
    id: _id,
    eventId: _e,
    createdAt: _c,
    storageKey: _s,
    category: _cat,
    uploadedBy: _u,
    sharedWith: _w,
    ...resto
  }: Record<string, unknown>) => resto

  const titulos = (lista: { title: string }[]) => lista.map((i) => i.title)
  const miembro = (userId: string): Visor => ({ tipo: 'miembro', userId })
  const proveedorVisor = (userId: string): Visor => ({ tipo: 'proveedor', userId })

  async function subir(
    m: Mundo,
    eventId: string,
    categoryId: string,
    uploadedById: string,
    t: string,
  ) {
    await pausa()
    return m.repo.crearImagen({
      eventId,
      categoryId,
      title: t,
      storageKey: `events/${eventId}/moodboard/${randomUUID()}.jpg`,
      width: 800,
      height: 600,
      uploadedById,
    })
  }

  /** Mundo común: un evento ACTIVE, un miembro, un proveedor con DOS contrataciones BOOKED. */
  async function escenario(m: Mundo) {
    const eventId = await m.evento('ACTIVE')
    const categoryId = await m.categoria()
    const ana = await m.usuario('Ana')
    const prov = await m.proveedor('Flores del Sur')
    const a = await m.contratacion({
      eventId,
      userId: prov,
      name: 'Flores del Sur',
      status: 'BOOKED',
    })
    const b = await m.contratacion({
      eventId,
      userId: prov,
      name: 'Flores del Sur',
      status: 'BOOKED',
    })
    return { eventId, categoryId, ana, prov, a, b }
  }

  it('crea y lista como miembro: orden createdAt desc y noteCount 0', async () => {
    await conAmbos(escenario, async (m, e, nombre) => {
      const uno = await subir(m, e.eventId, e.categoryId, e.ana, 'Uno')
      await subir(m, e.eventId, e.categoryId, e.ana, 'Dos')
      await subir(m, e.eventId, e.categoryId, e.ana, 'Tres')
      expect(sinVolatiles({ ...uno }), nombre).toEqual({
        title: 'Uno',
        width: 800,
        height: 600,
        archivedAt: null,
        noteCount: 0,
      })
      expect(uno.uploadedBy.name, nombre).toBe('Ana')
      const lista = await m.repo.listarImagenes(e.eventId, miembro(e.ana), false)
      expect(titulos(lista), nombre).toEqual(['Tres', 'Dos', 'Uno'])
      expect(
        lista.map((i) => i.noteCount),
        nombre,
      ).toEqual([0, 0, 0])
    })
  })

  it('las archivadas sólo salen con archivadas = true, y se recuperan', async () => {
    await conAmbos(escenario, async (m, e, nombre) => {
      const uno = await subir(m, e.eventId, e.categoryId, e.ana, 'Uno')
      await subir(m, e.eventId, e.categoryId, e.ana, 'Dos')
      await m.repo.fijarArchivo(uno.id, e.ana)
      const activas = await m.repo.listarImagenes(e.eventId, miembro(e.ana), false)
      const archivadas = await m.repo.listarImagenes(e.eventId, miembro(e.ana), true)
      expect(titulos(activas), nombre).toEqual(['Dos'])
      expect(titulos(archivadas), nombre).toEqual(['Uno'])
      expect(archivadas[0]?.archivedAt, nombre).toBeInstanceOf(Date)
      await m.repo.fijarArchivo(uno.id, null)
      const todas = await m.repo.listarImagenes(e.eventId, miembro(e.ana), false)
      expect(titulos(todas), nombre).toEqual(['Dos', 'Uno'])
      expect(todas[1]?.archivedAt, nombre).toBeNull()
    })
  })

  it('un proveedor ve sólo lo compartido con cualquiera de sus dos contrataciones', async () => {
    await conAmbos(escenario, async (m, e, nombre) => {
      const f1 = await subir(m, e.eventId, e.categoryId, e.ana, 'Con A')
      const f2 = await subir(m, e.eventId, e.categoryId, e.ana, 'Con B')
      await subir(m, e.eventId, e.categoryId, e.ana, 'Sin compartir')
      await m.repo.fijarComparticion(f1.id, [e.a], e.ana)
      await m.repo.fijarComparticion(f2.id, [e.b], e.ana)
      const vistas = await m.repo.listarImagenes(e.eventId, proveedorVisor(e.prov), false)
      expect(titulos(vistas), nombre).toEqual(['Con B', 'Con A'])
      expect(
        await m.repo.buscarImagen(e.eventId, f1.id, proveedorVisor(e.prov)),
        nombre,
      ).not.toBeNull()
      const otro = await m.proveedor('Otro')
      expect(await m.repo.listarImagenes(e.eventId, proveedorVisor(otro), false), nombre).toEqual(
        [],
      )
      expect(await m.repo.listarImagenes(e.eventId, proveedorVisor(e.prov), true), nombre).toEqual(
        [],
      )
    })
  })

  it('el proveedor deja de verla si se revoca, se archiva, se cancela su contratación o el evento no está ACTIVE', async () => {
    await conAmbos(escenario, async (m, e, nombre) => {
      const f = await subir(m, e.eventId, e.categoryId, e.ana, 'Foto')
      const ve = async () =>
        (await m.repo.buscarImagen(e.eventId, f.id, proveedorVisor(e.prov))) !== null
      await m.repo.fijarComparticion(f.id, [e.a], e.ana)
      expect(await ve(), `${nombre} compartida`).toBe(true)

      await m.repo.fijarComparticion(f.id, [], e.ana)
      expect(await ve(), `${nombre} revocada`).toBe(false)
      await m.repo.fijarComparticion(f.id, [e.a], e.ana)
      expect(await ve(), `${nombre} reavivada`).toBe(true)

      await m.repo.fijarArchivo(f.id, e.ana)
      expect(await ve(), `${nombre} archivada`).toBe(false)
      await m.repo.fijarArchivo(f.id, null)
      expect(await ve(), `${nombre} recuperada`).toBe(true)

      await m.cambiarEvento(e.eventId, 'DRAFT')
      expect(await ve(), `${nombre} evento DRAFT`).toBe(false)
      await m.cambiarEvento(e.eventId, 'ACTIVE')

      await m.cambiarContratacion(e.a, 'CANCELLED')
      expect(await ve(), `${nombre} contratación cancelada`).toBe(false)
      expect(await m.repo.proveedoresQueVen(f.id), nombre).toEqual([])
    })
  })

  it('fijarComparticion: altas y bajas, y volver a compartir reaviva sin duplicar', async () => {
    await conAmbos(escenario, async (m, e, nombre) => {
      const f = await subir(m, e.eventId, e.categoryId, e.ana, 'Foto')
      const ordenados = (r: { altas: string[]; bajas: string[] }) => ({
        altas: [...r.altas].sort(),
        bajas: [...r.bajas].sort(),
      })
      expect(ordenados(await m.repo.fijarComparticion(f.id, [e.a, e.b], e.ana)), nombre).toEqual({
        altas: [e.a, e.b].sort(),
        bajas: [],
      })
      expect(await m.repo.fijarComparticion(f.id, [e.b], e.ana), nombre).toEqual({
        altas: [],
        bajas: [e.a],
      })
      expect(await m.repo.fijarComparticion(f.id, [e.a, e.b], e.ana), nombre).toEqual({
        altas: [e.a],
        bajas: [],
      })
      expect(await m.repo.fijarComparticion(f.id, [e.a, e.b], e.ana), nombre).toEqual({
        altas: [],
        bajas: [],
      })
      const vista = await m.repo.buscarImagen(e.eventId, f.id, miembro(e.ana))
      expect(vista?.sharedWith.map((s) => s.eventVendorId).sort(), nombre).toEqual(
        [e.a, e.b].sort(),
      )
      expect(vista?.sharedWith[0]?.name, nombre).toBe('Flores del Sur')
    })
    // Sólo en Prisma se puede contar filas: sigue habiendo UNA por (foto, contratación).
    const m = mundoPrisma()
    const e = await escenario(m)
    const f = await subir(m, e.eventId, e.categoryId, e.ana, 'Foto')
    await m.repo.fijarComparticion(f.id, [e.a, e.b], e.ana)
    await m.repo.fijarComparticion(f.id, [e.b], e.ana)
    await m.repo.fijarComparticion(f.id, [e.a, e.b], e.ana)
    expect(
      await prisma.moodboardShare.count({ where: { imageId: f.id, eventVendorId: e.a } }),
    ).toBe(1)
    expect(await prisma.moodboardShare.count({ where: { imageId: f.id, revokedAt: null } })).toBe(2)
  })

  it('listarCompartibles excluye SHORTLISTED, CANCELLED y externos, ordenadas por nombre', async () => {
    await conAmbos(
      async (m) => {
        const eventId = await m.evento('ACTIVE')
        await m.categoria()
        const zeta = await m.proveedor('Zeta Música')
        const alfa = await m.proveedor('Alfa Foto')
        const cola = await m.proveedor('Cola')
        const bz = await m.contratacion({
          eventId,
          userId: zeta,
          name: 'Zeta Música',
          status: 'BOOKED',
        })
        const ba = await m.contratacion({
          eventId,
          userId: alfa,
          name: 'Alfa Foto',
          status: 'BOOKED',
        })
        await m.contratacion({ eventId, userId: cola, name: 'Cola', status: 'SHORTLISTED' })
        await m.contratacion({ eventId, userId: cola, name: 'Cola', status: 'CANCELLED' })
        await m.contratacion({ eventId, userId: null, name: 'Externo', status: 'BOOKED' })
        return { eventId, ba, bz }
      },
      async (m, d, nombre) => {
        const lista = await m.repo.listarCompartibles(d.eventId)
        expect(
          lista.map((c) => [c.eventVendorId, c.name]),
          nombre,
        ).toEqual([
          [d.ba, 'Alfa Foto'],
          [d.bz, 'Zeta Música'],
        ])
        expect(lista[0]?.categoryName.length, nombre).toBeGreaterThan(0)
      },
    )
  })

  it('proveedoresQueVen y usuariosDeContrataciones devuelven los userId esperados', async () => {
    await conAmbos(
      async (m) => {
        const base = await escenario(m)
        const otro = await m.proveedor('Otro')
        const c = await m.contratacion({
          eventId: base.eventId,
          userId: otro,
          name: 'Otro',
          status: 'BOOKED',
        })
        const ext = await m.contratacion({
          eventId: base.eventId,
          userId: null,
          name: 'Externo',
          status: 'BOOKED',
        })
        const f = await subir(m, base.eventId, base.categoryId, base.ana, 'Foto')
        await m.repo.fijarComparticion(f.id, [base.a, base.b, c], base.ana)
        return { ...base, otro, c, ext, f }
      },
      async (m, d, nombre) => {
        expect((await m.repo.proveedoresQueVen(d.f.id)).sort(), nombre).toEqual(
          [d.prov, d.otro].sort(),
        )
        expect(
          (await m.repo.usuariosDeContrataciones([d.a, d.b, d.c, d.ext])).sort(),
          nombre,
        ).toEqual([d.prov, d.otro].sort())
        expect(await m.repo.usuariosDeContrataciones([]), nombre).toEqual([])
      },
    )
  })

  it('categoriaActiva distingue activas, inactivas y desconocidas', async () => {
    await conAmbos(
      async (m) => ({ viva: await m.categoria(true), muerta: await m.categoria(false) }),
      async (m, d, nombre) => {
        expect(await m.repo.categoriaActiva(d.viva), nombre).toBe(true)
        expect(await m.repo.categoriaActiva(d.muerta), nombre).toBe(false)
        expect(await m.repo.categoriaActiva(randomUUID()), nombre).toBe(false)
      },
    )
  })
})

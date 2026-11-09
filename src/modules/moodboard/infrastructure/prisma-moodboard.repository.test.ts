import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { CompartirImagenUseCase, CrearNotaUseCase } from '../application/moodboard.use-cases'
import { exigirCupo, MAX_IMAGENES_POR_EVENTO } from '../domain/moodboard'
import { ImagenArchivadaError, TopeDeImagenesError } from '../domain/moodboard-errors'
import { PrismaMoodboardRepository } from './prisma-moodboard.repository'

describe('PrismaMoodboardRepository (Postgres real)', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let userId: string
  let categoryId: string
  let eventId: string
  let imageId: string
  let eventVendorId: string

  /** INSERT directo de una foto: lo único que se varía es lo que cada CHECK vigila. */
  async function insertarImagen(
    campos: {
      title?: string
      width?: number
      archivedAt?: Date | null
      archivedById?: string | null
    } = {},
  ): Promise<number> {
    const { title = 'Foto', width = 100, archivedAt = null, archivedById = null } = campos
    return await prisma.$executeRaw`
      INSERT INTO moodboard_images
        (id, "eventId", "categoryId", title, "storageKey", width, height, "uploadedById",
         "archivedAt", "archivedById", "updatedAt")
      VALUES
        (${randomUUID()}::uuid, ${eventId}::uuid, ${categoryId}::uuid, ${title},
         ${`k-${randomUUID()}`}, ${width}, 100, ${userId}::uuid,
         ${archivedAt}, ${archivedById}::uuid, now())
    `
  }

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    const user = await prisma.user.create({
      data: { email: 'owner@int-moodboard.test', passwordHash: 'x', fullName: 'Owner' },
    })
    userId = user.id
    categoryId = (
      await prisma.vendorCategory.create({
        data: { slug: 'int-moodboard', name: 'Int Moodboard', position: 1 },
      })
    ).id
    eventId = (await prisma.event.create({ data: { name: 'Boda', ownerId: userId } })).id
    imageId = (
      await prisma.moodboardImage.create({
        data: {
          eventId,
          categoryId,
          title: 'Base',
          storageKey: 'k-base',
          width: 10,
          height: 10,
          uploadedById: userId,
        },
      })
    ).id
    eventVendorId = (
      await prisma.eventVendor.create({
        data: { eventId, categoryId, externalName: 'Ext', status: 'BOOKED' },
      })
    ).id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  describe('CHECK de la base', () => {
    it('rechaza un título de 121 caracteres', async () => {
      await expect(insertarImagen({ title: 'x'.repeat(121) })).rejects.toThrow(
        /moodboard_images_titulo/,
      )
    })

    it('rechaza un título que son sólo espacios', async () => {
      await expect(insertarImagen({ title: '  ' })).rejects.toThrow(/moodboard_images_titulo/)
    })

    it('rechaza width = 0', async () => {
      await expect(insertarImagen({ width: 0 })).rejects.toThrow(/moodboard_images_dimensiones/)
    })

    it('rechaza archivedAt sin archivedById', async () => {
      await expect(insertarImagen({ archivedAt: new Date() })).rejects.toThrow(
        /moodboard_images_archivado_coherente/,
      )
    })

    it('acepta la foto válida y la archivada con quién la archivó', async () => {
      await expect(insertarImagen()).resolves.toBe(1)
      await expect(insertarImagen({ archivedAt: new Date(), archivedById: userId })).resolves.toBe(
        1,
      )
    })

    it('rechaza una nota vacía y una de 2.001 caracteres', async () => {
      const insertar = async (body: string) =>
        await prisma.$executeRaw`
          INSERT INTO moodboard_notes (id, "imageId", "authorId", body)
          VALUES (${randomUUID()}::uuid, ${imageId}::uuid, ${userId}::uuid, ${body})
        `
      await expect(insertar('   ')).rejects.toThrow(/moodboard_notes_cuerpo/)
      await expect(insertar('x'.repeat(2001))).rejects.toThrow(/moodboard_notes_cuerpo/)
      await expect(insertar('x'.repeat(2000))).resolves.toBe(1)
    })
  })

  describe('unicidad', () => {
    it('rechaza una storageKey duplicada con P2002', async () => {
      await expect(
        prisma.moodboardImage.create({
          data: {
            eventId,
            categoryId,
            title: 'Otra',
            storageKey: 'k-base',
            width: 10,
            height: 10,
            uploadedById: userId,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' })
    })

    it('rechaza una segunda fila (imagen, contratación) con P2002', async () => {
      const crear = () =>
        prisma.moodboardShare.create({ data: { imageId, eventVendorId, sharedById: userId } })
      await crear()
      await expect(crear()).rejects.toMatchObject({ code: 'P2002' })
    })
  })

  describe('lecturas dentro de una unidad de trabajo', () => {
    it('proveedoresQueVen ve la revocación aún sin confirmar', async () => {
      const servicio = prisma as unknown as PrismaService
      const repo = new PrismaMoodboardRepository(servicio)
      const unidad = new PrismaUnidadDeTrabajo(servicio)
      const u = await prisma.user.create({
        data: { email: 'rw@int-moodboard.test', passwordHash: 'x', fullName: 'Prov A' },
      })
      const perfil = await prisma.vendorProfile.create({
        data: { userId: u.id, businessName: 'Prov A', categoryId },
      })
      const evento = await prisma.event.create({
        data: {
          name: 'RW',
          ownerId: userId,
          status: 'ACTIVE',
          weddingDate: new Date('2027-06-12'),
        },
      })
      const contratacion = await prisma.eventVendor.create({
        data: { eventId: evento.id, categoryId, vendorProfileId: perfil.id, status: 'BOOKED' },
      })
      const foto = await repo.crearImagen({
        eventId: evento.id,
        categoryId,
        title: 'RW',
        storageKey: 'k-rw',
        width: 10,
        height: 10,
        uploadedById: userId,
      })
      await repo.fijarComparticion(foto.id, [contratacion.id], userId)
      expect(await repo.proveedoresQueVen(foto.id)).toEqual([u.id])

      const dentro = await unidad.ejecutar(async () => {
        await repo.fijarComparticion(foto.id, [], userId)
        return await repo.proveedoresQueVen(foto.id)
      })
      expect(dentro).not.toContain(u.id)
    })
  })

  describe('tope de imágenes con concurrencia', () => {
    it('con 499 fotos, dos subidas en paralelo: una falla y quedan 500', async () => {
      const dueno = await prisma.user.create({
        data: { email: 'tope@int-moodboard.test', passwordHash: 'x', fullName: 'Tope' },
      })
      const evento = await prisma.event.create({ data: { name: 'Tope', ownerId: dueno.id } })
      await prisma.moodboardImage.createMany({
        data: Array.from({ length: MAX_IMAGENES_POR_EVENTO - 1 }, (_, n) => ({
          eventId: evento.id,
          categoryId,
          title: `F${n}`,
          storageKey: `tope-${n}`,
          width: 10,
          height: 10,
          uploadedById: dueno.id,
        })),
      })

      const servicio = prisma as unknown as PrismaService
      const repo = new PrismaMoodboardRepository(servicio)
      const unidad = new PrismaUnidadDeTrabajo(servicio)
      const subir = (clave: string) =>
        unidad.ejecutar(async () => {
          exigirCupo(await repo.bloquearYContar(evento.id))
          return await repo.crearImagen({
            eventId: evento.id,
            categoryId,
            title: clave,
            storageKey: clave,
            width: 10,
            height: 10,
            uploadedById: dueno.id,
          })
        })

      const resultados = await Promise.allSettled([subir('par-1'), subir('par-2')])
      const fallos = resultados.filter((r) => r.status === 'rejected')
      expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(fallos).toHaveLength(1)
      expect((fallos[0] as PromiseRejectedResult).reason).toBeInstanceOf(TopeDeImagenesError)
      expect(await prisma.moodboardImage.count({ where: { eventId: evento.id } })).toBe(
        MAX_IMAGENES_POR_EVENTO,
      )
    }, 60_000)
  })

  describe('bloqueo de la foto', () => {
    /**
     * Espera a que alguna sesión esté bloqueada esperando un lock de fila. Si en
     * 5 s nadie espera, sigue: sin el bloqueo en el caso de uso, B no espera
     * nunca y el test debe fallar en las aserciones, no colgarse.
     */
    async function esperarAQueAlguienEspere(): Promise<void> {
      for (let i = 0; i < 100; i++) {
        const [fila] = await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND datname = current_database()`
        if ((fila?.n ?? 0n) > 0n) return
        await new Promise((r) => setTimeout(r, 50))
      }
    }

    /**
     * A bloquea y archiva la foto y NO confirma hasta que B (nota o
     * compartición, el caso de uso real) está esperando su lock; entonces
     * confirma. B debe releer `archivedAt` ya confirmado y fallar con
     * MOODBOARD_IMAGE_ARCHIVED sin escribir nada.
     */
    it.each(['nota', 'compartir'] as const)(
      '%s: concurrente con un archivado, espera y ve la foto archivada',
      async (accion) => {
        const servicio = prisma as unknown as PrismaService
        const repo = new PrismaMoodboardRepository(servicio)
        const unidad = new PrismaUnidadDeTrabajo(servicio)
        const avisos = new NotificationPortEnMemoria()
        const cola = new InMemoryQueueAdapter()

        const u = await prisma.user.create({
          data: { email: `lock-${accion}@int-moodboard.test`, passwordHash: 'x', fullName: 'P' },
        })
        const perfil = await prisma.vendorProfile.create({
          data: { userId: u.id, businessName: `Lock ${accion}`, categoryId },
        })
        const evento = await prisma.event.create({
          data: {
            name: `Lock ${accion}`,
            ownerId: userId,
            status: 'ACTIVE',
            weddingDate: new Date('2027-06-12'),
          },
        })
        const contratacion = await prisma.eventVendor.create({
          data: { eventId: evento.id, categoryId, vendorProfileId: perfil.id, status: 'BOOKED' },
        })
        const foto = await repo.crearImagen({
          eventId: evento.id,
          categoryId,
          title: 'Lock',
          storageKey: `k-lock-${accion}`,
          width: 10,
          height: 10,
          uploadedById: userId,
        })

        let avisarBloqueada: () => void = () => undefined
        const bloqueada = new Promise<void>((r) => (avisarBloqueada = r))
        const archivar = unidad.ejecutar(async () => {
          await repo.bloquearImagen(evento.id, foto.id)
          await repo.fijarArchivo(foto.id, userId)
          avisarBloqueada()
          await esperarAQueAlguienEspere()
        })

        await bloqueada
        const miembro = { tipo: 'miembro' as const, userId }
        const escribir =
          accion === 'nota'
            ? new CrearNotaUseCase(repo, unidad, avisos, cola).ejecutar(
                evento.id,
                foto.id,
                miembro,
                'Tarde',
              )
            : new CompartirImagenUseCase(repo, unidad, avisos, cola).ejecutar(
                evento.id,
                foto.id,
                userId,
                [contratacion.id],
              )

        const [a, b] = await Promise.allSettled([archivar, escribir])
        expect(a.status).toBe('fulfilled')
        expect(b.status).toBe('rejected')
        expect((b as PromiseRejectedResult).reason).toBeInstanceOf(ImagenArchivadaError)
        expect(await prisma.moodboardNote.count({ where: { imageId: foto.id } })).toBe(0)
        expect(
          await prisma.moodboardShare.count({ where: { imageId: foto.id, revokedAt: null } }),
        ).toBe(0)
        expect(avisos.creadas).toHaveLength(0)
      },
      30_000,
    )
  })
})

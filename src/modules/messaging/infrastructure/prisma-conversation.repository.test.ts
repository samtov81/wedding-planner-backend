import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { PrismaConversationRepository } from './prisma-conversation.repository'

describe('PrismaConversationRepository', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let repo: PrismaConversationRepository
  let eventId: string
  let aId: string
  let bId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })
    repo = new PrismaConversationRepository(prisma as unknown as PrismaService)

    const crear = async (email: string): Promise<string> =>
      (await prisma.user.create({ data: { email, passwordHash: 'x', fullName: email } })).id
    aId = await crear('a@conv.test')
    bId = await crear('b@conv.test')
    const evento = await prisma.event.create({ data: { name: 'Boda', ownerId: aId } })
    eventId = evento.id
    await prisma.eventMembership.createMany({
      data: [
        { eventId, userId: aId, role: 'COUPLE', status: 'ACTIVE' },
        { eventId, userId: bId, role: 'PLANNER', status: 'ACTIVE' },
      ],
    })
  }, 240_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  it('dos abrir concurrentes del mismo par crean una sola conversación', async () => {
    const resultados = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        i % 2 === 0 ? repo.abrir(eventId, aId, bId) : repo.abrir(eventId, bId, aId),
      ),
    )

    expect(new Set(resultados.map((r) => r.id)).size).toBe(1)
    expect(resultados.filter((r) => r.creada)).toHaveLength(1)
    expect(await prisma.conversation.count({ where: { eventId } })).toBe(1)
    expect(await prisma.conversationParticipant.count()).toBe(2)
  })

  it('el CHECK rechaza un cuerpo vacío insertado a mano', async () => {
    const { id } = await repo.abrir(eventId, aId, bId)

    await expect(
      prisma.$executeRaw`INSERT INTO "messages" ("id", "conversationId", "senderId", "body")
        VALUES (gen_random_uuid(), ${id}::uuid, ${aId}::uuid, '   ')`,
    ).rejects.toThrow(/messages_cuerpo_longitud/)
  })

  it('el CHECK rechaza una marca a medias (instante sin id)', async () => {
    const { id } = await repo.abrir(eventId, aId, bId)

    await expect(
      prisma.$executeRaw`UPDATE "conversation_participants" SET "readUpToAt" = now()
        WHERE "conversationId" = ${id}::uuid AND "userId" = ${aId}::uuid`,
    ).rejects.toThrow(/conversation_participants_leido_par/)
    await expect(
      prisma.$executeRaw`UPDATE "conversation_participants" SET "deliveredUpToId" = gen_random_uuid()
        WHERE "conversationId" = ${id}::uuid AND "userId" = ${aId}::uuid`,
    ).rejects.toThrow(/conversation_participants_recibido_par/)
  })

  it('dos marcados concurrentes no retroceden la marca', async () => {
    const { id } = await repo.abrir(eventId, aId, bId)
    const viejo = await repo.agregarMensaje(id, bId, 'viejo', new Date('2026-03-01T00:00:00Z'))
    const nuevo = await repo.agregarMensaje(id, bId, 'nuevo', new Date('2026-03-01T00:05:00Z'))

    await Promise.all([
      repo.marcar(id, aId, 'read', nuevo.id),
      repo.marcar(id, aId, 'read', viejo.id),
      repo.marcar(id, aId, 'read', viejo.id),
    ])

    const vista = await repo.marcar(id, aId, 'read', viejo.id)
    if (vista === false) throw new Error('debía aceptar el upTo')
    expect(vista.readUpTo?.id).toBe(nuevo.id)
  })

  it('abrir un par que ya existe dentro de una unidad de trabajo no aborta la transacción', async () => {
    const existente = await repo.abrir(eventId, aId, bId)
    const unidad = new PrismaUnidadDeTrabajo(prisma as unknown as PrismaService)

    const { reabierta, mensaje } = await unidad.ejecutar(async () => {
      const reabierta = await repo.abrir(eventId, bId, aId)
      // Otra escritura en la misma transacción: falla si ésta quedó abortada.
      const mensaje = await repo.agregarMensaje(existente.id, aId, 'tras abrir', new Date())
      return { reabierta, mensaje }
    })

    expect(reabierta).toEqual({ id: existente.id, creada: false })
    expect(await prisma.message.count({ where: { id: mensaje.id } })).toBe(1)
  })

  it('abrir concurrente dentro de unidades de trabajo distintas tampoco falla', async () => {
    const otroEvento = await prisma.event.create({ data: { name: 'Otra', ownerId: aId } })
    const unidad = new PrismaUnidadDeTrabajo(prisma as unknown as PrismaService)

    const resultados = await Promise.all(
      Array.from({ length: 4 }, () =>
        unidad.ejecutar(async () => {
          const r = await repo.abrir(otroEvento.id, aId, bId)
          await repo.agregarMensaje(r.id, aId, 'hola', new Date())
          return r
        }),
      ),
    )

    expect(new Set(resultados.map((r) => r.id)).size).toBe(1)
    expect(resultados.filter((r) => r.creada)).toHaveLength(1)
  })
})

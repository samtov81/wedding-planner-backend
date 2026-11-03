import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'

import { categoriaId } from '../../../../test/support/categorias'
import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import { SolicitudPendienteError } from '../domain/messaging-errors'
import { claveDePerfil } from '../domain/perfil'
import type { FichaParaContacto } from '../application/conversation.repository'
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

  it('dos abrirSala concurrentes del mismo evento crean una sola sala', async () => {
    const evento = await prisma.event.create({ data: { name: 'Sala', ownerId: aId } })
    await prisma.eventMembership.createMany({
      data: [
        { eventId: evento.id, userId: aId, role: 'COUPLE', status: 'ACTIVE' },
        { eventId: evento.id, userId: bId, role: 'PLANNER', status: 'ACTIVE' },
      ],
    })

    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, i) => repo.abrirSala(evento.id, i % 2 === 0 ? aId : bId)),
    )

    expect(new Set(ids).size).toBe(1)
    expect(await prisma.conversation.count({ where: { eventId: evento.id } })).toBe(1)
    expect(
      await prisma.conversationParticipant.count({ where: { conversationId: ids[0] ?? '' } }),
    ).toBe(2)
  })

  it('el CHECK rechaza una sala con pairKey ajena', async () => {
    await expect(
      prisma.$executeRaw`INSERT INTO "conversations" ("id", "kind", "eventId", "pairKey")
        VALUES (gen_random_uuid(), 'EVENT_ROOM'::"ConversationKind", ${eventId}::uuid, 'room:otra')`,
    ).rejects.toThrow(/conversations_sala_clave/)
  })

  // ── Contacto desde la ficha (parte 3) ──────────────────────────────────────

  describe('PROFILE', () => {
    let v1: FichaParaContacto
    let v2: FichaParaContacto

    beforeAll(async () => {
      const proveedor = async (email: string, businessName: string): Promise<FichaParaContacto> => {
        const userId = (
          await prisma.user.create({ data: { email, passwordHash: 'x', fullName: email } })
        ).id
        const ficha = await prisma.vendorProfile.create({
          data: {
            userId,
            businessName,
            categoryId: await categoriaId(prisma),
            status: 'PUBLISHED',
          },
        })
        return { id: ficha.id, userId, businessName, publicada: true }
      }
      v1 = await proveedor('v1@perfil.test', 'Uno')
      v2 = await proveedor('v2@perfil.test', 'Dos')
    })

    it('A→B y B→A concurrentes crean una sola conversación y la otra recibe SolicitudPendienteError', async () => {
      const ahora = new Date('2026-03-01T00:00:00Z')
      const resultados = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          i % 2 === 0
            ? repo.solicitar({
                solicitante: v1.userId,
                ficha: v2,
                cuerpo: 'de uno',
                relacionados: false,
                ahora,
              })
            : repo.solicitar({
                solicitante: v2.userId,
                ficha: v1,
                cuerpo: 'de dos',
                relacionados: false,
                ahora,
              }),
        ),
      )

      const ganadoras = resultados.filter((r) => r.status === 'fulfilled')
      const perdedoras = resultados.flatMap((r) =>
        r.status === 'rejected' ? [r.reason as unknown] : [],
      )
      expect(ganadoras).toHaveLength(1)
      expect(perdedoras).toHaveLength(5)
      for (const error of perdedoras) expect(error).toBeInstanceOf(SolicitudPendienteError)
      const pairKey = claveDePerfil(v1.userId, v2.userId)
      expect(await prisma.conversation.count({ where: { pairKey } })).toBe(1)
      const conv = await prisma.conversation.findUniqueOrThrow({ where: { pairKey } })
      expect(await prisma.message.count({ where: { conversationId: conv.id } })).toBe(1)
      expect(
        await prisma.conversationParticipant.count({ where: { conversationId: conv.id } }),
      ).toBe(2)
    })

    it('el CHECK conversations_perfil_campos rechaza un PROFILE sin estado o con evento', async () => {
      const clave = `profile:campos:${v1.userId}`
      await expect(
        prisma.$executeRaw`INSERT INTO "conversations"
          ("id", "kind", "pairKey", "requesterId", "vendorProfileId")
          VALUES (gen_random_uuid(), 'PROFILE'::"ConversationKind", ${clave},
            ${v1.userId}::uuid, ${v2.id}::uuid)`,
      ).rejects.toThrow(/conversations_perfil_campos/)
      await expect(
        prisma.$executeRaw`INSERT INTO "conversations"
          ("id", "kind", "eventId", "pairKey", "requesterId", "vendorProfileId", "requestStatus")
          VALUES (gen_random_uuid(), 'PROFILE'::"ConversationKind", ${eventId}::uuid, ${clave},
            ${v1.userId}::uuid, ${v2.id}::uuid, 'PENDING'::"ContactRequestStatus")`,
      ).rejects.toThrow(/conversations_perfil_campos/)
    })

    it('el CHECK conversations_perfil_solo_en_perfil rechaza columnas de perfil en una 1:1 o una sala', async () => {
      const directa = (n: string): string => `direct:solo:${n}`
      const rechazos = [
        prisma.$executeRaw`INSERT INTO "conversations" ("id", "kind", "eventId", "pairKey", "requestStatus")
          VALUES (gen_random_uuid(), 'EVENT_DIRECT'::"ConversationKind", ${eventId}::uuid,
            ${directa('estado')}, 'PENDING'::"ContactRequestStatus")`,
        prisma.$executeRaw`INSERT INTO "conversations" ("id", "kind", "eventId", "pairKey", "requesterId")
          VALUES (gen_random_uuid(), 'EVENT_DIRECT'::"ConversationKind", ${eventId}::uuid,
            ${directa('solicitante')}, ${v1.userId}::uuid)`,
        prisma.$executeRaw`INSERT INTO "conversations" ("id", "kind", "eventId", "pairKey", "vendorProfileId")
          VALUES (gen_random_uuid(), 'EVENT_DIRECT'::"ConversationKind", ${eventId}::uuid,
            ${directa('ficha')}, ${v2.id}::uuid)`,
        // DECLINED + declinedAt: `conversations_perfil_rechazo` se cumple, sólo falla éste.
        prisma.$executeRaw`INSERT INTO "conversations"
          ("id", "kind", "eventId", "pairKey", "requestStatus", "declinedAt")
          VALUES (gen_random_uuid(), 'EVENT_DIRECT'::"ConversationKind", ${eventId}::uuid,
            ${directa('rechazo')}, 'DECLINED'::"ContactRequestStatus", now())`,
        prisma.$executeRaw`INSERT INTO "conversations" ("id", "kind", "eventId", "pairKey", "requesterId")
          VALUES (gen_random_uuid(), 'EVENT_ROOM'::"ConversationKind", ${eventId}::uuid,
            ${`room:${eventId}`}, ${v1.userId}::uuid)`,
      ]
      for (const intento of rechazos) {
        await expect(intento).rejects.toThrow(/conversations_perfil_solo_en_perfil/)
      }
    })

    it('el CHECK conversations_perfil_rechazo ata declinedAt a DECLINED', async () => {
      const clave = `profile:rechazo:${v1.userId}`
      await expect(
        prisma.$executeRaw`INSERT INTO "conversations"
          ("id", "kind", "pairKey", "requesterId", "vendorProfileId", "requestStatus")
          VALUES (gen_random_uuid(), 'PROFILE'::"ConversationKind", ${clave},
            ${v1.userId}::uuid, ${v2.id}::uuid, 'DECLINED'::"ContactRequestStatus")`,
      ).rejects.toThrow(/conversations_perfil_rechazo/)
      await expect(
        prisma.$executeRaw`INSERT INTO "conversations"
          ("id", "kind", "pairKey", "requesterId", "vendorProfileId", "requestStatus", "declinedAt")
          VALUES (gen_random_uuid(), 'PROFILE'::"ConversationKind", ${clave},
            ${v1.userId}::uuid, ${v2.id}::uuid, 'PENDING'::"ContactRequestStatus", now())`,
      ).rejects.toThrow(/conversations_perfil_rechazo/)
    })

    it('el CHECK conversations_perfil_clave exige una pairKey profile: no nula', async () => {
      for (const clave of [`otra:${v1.userId}`, null]) {
        await expect(
          prisma.$executeRaw`INSERT INTO "conversations"
            ("id", "kind", "pairKey", "requesterId", "vendorProfileId", "requestStatus")
            VALUES (gen_random_uuid(), 'PROFILE'::"ConversationKind", ${clave},
              ${v1.userId}::uuid, ${v2.id}::uuid, 'PENDING'::"ContactRequestStatus")`,
        ).rejects.toThrow(/conversations_perfil_clave/)
      }
    })

    it('dos profile: con la misma clave chocan en el UNIQUE de pairKey', async () => {
      const clave = `profile:unica:${v1.userId}`
      const insertar = () =>
        prisma.$executeRaw`INSERT INTO "conversations"
          ("id", "kind", "pairKey", "requesterId", "vendorProfileId", "requestStatus")
          VALUES (gen_random_uuid(), 'PROFILE'::"ConversationKind", ${clave},
            ${v1.userId}::uuid, ${v2.id}::uuid, 'PENDING'::"ContactRequestStatus")`
      await expect(insertar()).resolves.toBe(1)
      await expect(insertar()).rejects.toThrow(/23505.*"pairKey"/s)
    })
  })
})

import { PrismaClient } from '@prisma/client'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'

/**
 * Las restricciones del adjunto de `messages` (spec 2026-11-12 §6) viven en la
 * base y no sólo en el caso de uso: un segundo camino de escritura no puede
 * saltárselas. Se prueban con Prisma contra Postgres real; el mensaje de un
 * error de CHECK lleva el nombre de la constraint, que es lo que se exige aquí.
 */
describe('messages: restricciones del adjunto', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let userId: string
  let conversationId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    const user = await prisma.user.create({
      data: { email: 'autor@adjuntos.test', passwordHash: 'x', fullName: 'Autor' },
    })
    userId = user.id
    const event = await prisma.event.create({
      data: { name: 'Boda', ownerId: userId, timezone: 'UTC', currency: 'USD' },
    })
    const conversation = await prisma.conversation.create({
      data: { kind: 'EVENT_ROOM', eventId: event.id },
    })
    conversationId = conversation.id
  }, 120_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  })

  function mensaje(extra: Record<string, unknown> = {}) {
    return prisma.message.create({
      data: { conversationId, senderId: userId, body: 'hola', ...extra },
    })
  }

  const adjunto = (key: string) => ({
    attachmentKey: key,
    attachmentName: 'a.pdf',
    attachmentType: 'application/pdf',
    attachmentBytes: 1234,
  })

  it('acepta un cuerpo vacío con el adjunto completo', async () => {
    await expect(
      mensaje({ body: '', ...adjunto('events/x/messages/y/vacio.pdf') }),
    ).resolves.toBeDefined()
  })

  it('rechaza un cuerpo vacío sin adjunto', async () => {
    await expect(mensaje({ body: '   ' })).rejects.toThrow(/messages_cuerpo_longitud/)
  })

  it('rechaza un adjunto con sólo la clave', async () => {
    await expect(mensaje({ attachmentKey: 'events/x/messages/y/incompleto.pdf' })).rejects.toThrow(
      /messages_adjunto_completo/,
    )
  })

  it('rechaza un adjunto de 0 bytes', async () => {
    await expect(
      mensaje({ ...adjunto('events/x/messages/y/cero.pdf'), attachmentBytes: 0 }),
    ).rejects.toThrow(/messages_adjunto_bytes/)
  })

  it('rechaza la misma key en dos mensajes', async () => {
    await mensaje(adjunto('events/x/messages/y/unica.pdf'))
    await expect(mensaje(adjunto('events/x/messages/y/unica.pdf'))).rejects.toMatchObject({
      code: 'P2002',
    })
  })
})

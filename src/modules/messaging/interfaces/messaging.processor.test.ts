import { randomUUID } from 'node:crypto'

import { UnrecoverableError, type Job } from 'bullmq'

import { RealtimePortEnMemoria } from '@/modules/notifications/infrastructure/realtime.port.fake'

import {
  COLA_MENSAJERIA,
  EVENTO_MENSAJE_CREADO,
  EVENTO_MENSAJE_RECIBO,
} from '../application/avisos-mensajeria'
import { ConversationRepositoryEnMemoria } from '../infrastructure/conversation.repository.fake'
import { MessagingProcessor } from './messaging.processor'

/** Clave de metadata de `@Processor` (no exportada por `@nestjs/bullmq`). */
const PROCESSOR_METADATA = 'bullmq:processor_metadata'

const EVENTO = randomUUID()
const PAREJA = randomUUID()
const PROV = randomUUID()

describe('MessagingProcessor', () => {
  let repo: ConversationRepositoryEnMemoria
  let realtime: RealtimePortEnMemoria
  let procesador: MessagingProcessor
  let conversationId: string

  const job = (name: string, data: unknown): Job =>
    ({ name, data, attemptsMade: 0, opts: { attempts: 5 } }) as Job

  beforeEach(async () => {
    repo = new ConversationRepositoryEnMemoria()
    repo.registrarEvento(EVENTO, 'Boda')
    repo.fijarPublicado(EVENTO, true)
    repo.registrarMiembro(EVENTO, PAREJA, 'COUPLE', 'ACTIVE', 'Pareja')
    repo.registrarProveedor(EVENTO, PROV, 'Foto', true)
    realtime = new RealtimePortEnMemoria()
    procesador = new MessagingProcessor(repo, realtime)
    conversationId = (await repo.abrir(EVENTO, PAREJA, PROV)).id
  })

  it('escucha la cola PROPIA del módulo, `messaging`', () => {
    expect(COLA_MENSAJERIA).toBe('messaging')
    expect(Reflect.getMetadata(PROCESSOR_METADATA, MessagingProcessor)).toMatchObject({
      name: 'messaging',
    })
  })

  it('message.created llega al otro participante y también al emisor (otras sesiones)', async () => {
    const m = await repo.agregarMensaje(conversationId, PAREJA, 'hola', new Date())

    await procesador.process(job(EVENTO_MENSAJE_CREADO, { conversationId, messageId: m.id }))

    const payload = {
      conversationId,
      message: {
        id: m.id,
        conversationId,
        senderId: PAREJA,
        body: 'hola',
        createdAt: m.createdAt.toISOString(),
      },
    }
    expect(realtime.emitidas).toHaveLength(2)
    expect(realtime.emitidas).toEqual(
      expect.arrayContaining([
        { destino: { userId: PROV }, tipo: 'message.created', payload },
        { destino: { userId: PAREJA }, tipo: 'message.created', payload },
      ]),
    )
  })

  it('no se emite a un proveedor que ya no puede ver la conversación', async () => {
    const m = await repo.agregarMensaje(conversationId, PAREJA, 'hola', new Date())
    repo.registrarProveedor(EVENTO, PROV, 'Foto', false)

    await procesador.process(job(EVENTO_MENSAJE_CREADO, { conversationId, messageId: m.id }))

    // Sólo el emisor (que sigue viéndola); el proveedor sin acceso no recibe nada.
    expect(realtime.emitidas.map((e) => e.destino)).toEqual([{ userId: PAREJA }])
  })

  it('message.receipt llega al otro participante con las marcas actuales', async () => {
    const m = await repo.agregarMensaje(conversationId, PAREJA, 'hola', new Date())
    await repo.marcar(conversationId, PROV, 'delivered', m.id)
    await repo.marcar(conversationId, PROV, 'read', m.id)

    await procesador.process(job(EVENTO_MENSAJE_RECIBO, { conversationId, userId: PROV }))

    const marca = { at: m.createdAt.toISOString(), id: m.id }
    expect(realtime.emitidas).toEqual([
      {
        destino: { userId: PAREJA },
        tipo: 'message.receipt',
        payload: { conversationId, userId: PROV, deliveredUpTo: marca, readUpTo: marca },
      },
    ])
  })

  it('message.receipt no se emite a quien ya no puede ver la conversación', async () => {
    const m = await repo.agregarMensaje(conversationId, PAREJA, 'hola', new Date())
    await repo.marcar(conversationId, PAREJA, 'read', m.id)
    repo.registrarProveedor(EVENTO, PROV, 'Foto', false)

    await procesador.process(job(EVENTO_MENSAJE_RECIBO, { conversationId, userId: PAREJA }))

    expect(realtime.emitidas).toEqual([])
  })

  describe('jobs irrecuperables', () => {
    it('un job roto es irrecuperable con mensaje claro', async () => {
      const roto = procesador.process(job(EVENTO_MENSAJE_CREADO, { conversationId: 'no-uuid' }))
      await expect(roto).rejects.toBeInstanceOf(UnrecoverableError)
      await expect(roto).rejects.toThrow(`Payload inválido en el job ${EVENTO_MENSAJE_CREADO}`)

      const rotoRecibo = procesador.process(job(EVENTO_MENSAJE_RECIBO, null))
      await expect(rotoRecibo).rejects.toThrow(
        `Payload inválido en el job ${EVENTO_MENSAJE_RECIBO}`,
      )
    })

    it('un nombre de job desconocido es irrecuperable', async () => {
      const raro = procesador.process(job('message.borrado', {}))
      await expect(raro).rejects.toBeInstanceOf(UnrecoverableError)
      await expect(raro).rejects.toThrow('Job desconocido en la cola messaging: message.borrado')
    })
  })

  it('los errores de emisión salen, para que BullMQ reintente', async () => {
    const m = await repo.agregarMensaje(conversationId, PAREJA, 'hola', new Date())
    realtime.fallarProximaEmision(new Error('redis caído'))

    await expect(
      procesador.process(job(EVENTO_MENSAJE_CREADO, { conversationId, messageId: m.id })),
    ).rejects.toThrow('redis caído')
  })
})

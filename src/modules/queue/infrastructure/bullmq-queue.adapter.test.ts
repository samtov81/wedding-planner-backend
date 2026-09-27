import { Queue } from 'bullmq'
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis'

import { BullmqQueueAdapter } from './bullmq-queue.adapter'

describe('BullmqQueueAdapter', () => {
  let redis: StartedRedisContainer
  let adaptador: BullmqQueueAdapter
  let cola: Queue

  beforeAll(async () => {
    redis = await new RedisContainer('redis:7-alpine').start()
    adaptador = new BullmqQueueAdapter({ REDIS_URL: redis.getConnectionUrl() })
    cola = new Queue('email', { connection: { url: redis.getConnectionUrl() } })
  }, 120_000)

  afterEach(async () => {
    await cola.obliterate({ force: true })
  })

  afterAll(async () => {
    await cola.close()
    await adaptador.onModuleDestroy()
    await redis.stop()
  })

  it('encola un job con el jobId que se le pide', async () => {
    await adaptador.enqueue(
      'email',
      'guest-invitation',
      { invitationId: 'inv-1' },
      { jobId: 'invitation-inv-1' },
    )

    const job = await cola.getJob('invitation-inv-1')
    expect(job?.data).toEqual({ invitationId: 'inv-1' })
  })

  it('NO duplica el job cuando se encola dos veces el mismo jobId', async () => {
    const datos = { invitationId: 'inv-1' }

    await adaptador.enqueue('email', 'guest-invitation', datos, { jobId: 'invitation-inv-1' })
    await adaptador.enqueue('email', 'guest-invitation', datos, { jobId: 'invitation-inv-1' })

    expect(await cola.getWaitingCount()).toBe(1)
  })

  it('configura reintentos con backoff exponencial', async () => {
    await adaptador.enqueue('email', 'guest-invitation', {}, { jobId: 'invitation-inv-2' })

    const job = await cola.getJob('invitation-inv-2')
    expect(job?.opts.attempts).toBe(5)
    expect(job?.opts.backoff).toMatchObject({ type: 'exponential' })
  })

  it('aplica la retención pedida: se borra al completar y el fallido caduca', async () => {
    await adaptador.enqueue(
      'email',
      'guest-invitation',
      {},
      { jobId: 'invitation-inv-3', removeOnComplete: true, removeOnFailAfterMs: 7 * 86_400_000 },
    )

    const job = await cola.getJob('invitation-inv-3')
    expect(job?.opts.removeOnComplete).toBe(true)
    expect(job?.opts.removeOnFail).toEqual({ age: 7 * 86_400 })
  })
})

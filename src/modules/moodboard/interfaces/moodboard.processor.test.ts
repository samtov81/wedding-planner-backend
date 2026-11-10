import { randomUUID } from 'node:crypto'

import { UnrecoverableError, type Job } from 'bullmq'

import { RealtimePortEnMemoria } from '@/modules/notifications/infrastructure/realtime.port.fake'

import {
  COLA_MOODBOARD,
  EVENTO_IMAGEN_CAMBIADA,
  EVENTO_IMAGEN_OCULTA,
  EVENTO_NOTA_CREADA,
  type JobImagenCambiada,
  type JobNotaCreada,
} from '../application/avisos-moodboard'
import { MoodboardRepositoryFake } from '../infrastructure/moodboard.repository.fake'
import { MoodboardProcessor } from './moodboard.processor'

/** Clave de metadata de `@Processor` (no exportada por `@nestjs/bullmq`). */
const PROCESSOR_METADATA = 'bullmq:processor_metadata'

const EVENTO = randomUUID()
const PAREJA = randomUUID()
const PROV = randomUUID()
const OTRO_PROV = randomUUID()
const CONTRATACION = randomUUID()
const SEGUNDA_CONTRATACION = randomUUID()
const CONTRATACION_OTRO = randomUUID()
const CATEGORIA = randomUUID()

const job = (name: string, data: unknown): Job =>
  ({ name, data, attemptsMade: 0, opts: { attempts: 5 } }) as Job

describe('MoodboardProcessor', () => {
  let repo: MoodboardRepositoryFake
  let realtime: RealtimePortEnMemoria
  let procesador: MoodboardProcessor
  let imageId: string

  const compartir = async (eventVendorIds: string[]): Promise<void> => {
    await repo.fijarComparticion(imageId, eventVendorIds, PAREJA)
  }

  beforeEach(async () => {
    repo = new MoodboardRepositoryFake()
    repo.sembrarEvento(EVENTO, { status: 'ACTIVE' })
    repo.sembrarCategoria({ id: CATEGORIA, slug: 'flores', name: 'Flores', active: true })
    repo.sembrarUsuario({ id: PAREJA, name: 'Pareja' })
    repo.sembrarUsuario({ id: PROV, name: 'Foto Pepe' })
    repo.sembrarUsuario({ id: OTRO_PROV, name: 'Flores Ana' })
    repo.sembrarMiembro({ eventId: EVENTO, userId: PAREJA, role: 'COUPLE', status: 'ACTIVE' })
    for (const [id, userId, categoryName] of [
      [CONTRATACION, PROV, 'Fotografía'],
      [SEGUNDA_CONTRATACION, PROV, 'Vídeo'],
      [CONTRATACION_OTRO, OTRO_PROV, 'Flores'],
    ] as const) {
      repo.sembrarContratacion({
        id,
        eventId: EVENTO,
        userId,
        name: 'Proveedor',
        categoryName,
        status: 'BOOKED',
      })
    }
    imageId = (
      await repo.crearImagen({
        eventId: EVENTO,
        categoryId: CATEGORIA,
        title: 'Centro de mesa',
        storageKey: `events/${EVENTO}/moodboard/a.jpg`,
        width: 800,
        height: 600,
        uploadedById: PAREJA,
      })
    ).id
    realtime = new RealtimePortEnMemoria()
    procesador = new MoodboardProcessor(repo, realtime)
  })

  it('escucha la cola PROPIA del módulo, `moodboard`', () => {
    expect(COLA_MOODBOARD).toBe('moodboard')
    expect(Reflect.getMetadata(PROCESSOR_METADATA, MoodboardProcessor)).toMatchObject({
      name: 'moodboard',
    })
  })

  describe('image.changed', () => {
    const cambio = (datos: Partial<JobImagenCambiada> = {}): JobImagenCambiada => ({
      eventId: EVENTO,
      imageId,
      ocultarA: [],
      campanaA: [],
      tipoCampana: null,
      ...datos,
    })

    it('llega a la sala del evento y a cada proveedor que HOY la ve, con sólo ids', async () => {
      await compartir([CONTRATACION])

      await procesador.process(job(EVENTO_IMAGEN_CAMBIADA, cambio()))

      const payload = { eventId: EVENTO, imageId }
      expect(realtime.emitidas).toEqual([
        { destino: { eventId: EVENTO }, tipo: 'moodboard.image.changed', payload },
        { destino: { userId: PROV }, tipo: 'moodboard.image.changed', payload },
      ])
    })

    it('image.hidden a quien dejó de verla, y no a quien la sigue viendo', async () => {
      await compartir([CONTRATACION])

      await procesador.process(job(EVENTO_IMAGEN_CAMBIADA, cambio({ ocultarA: [OTRO_PROV, PROV] })))

      const ocultas = realtime.emitidas.filter((e) => e.tipo === EVENTO_IMAGEN_OCULTA)
      expect(ocultas).toEqual([
        {
          destino: { userId: OTRO_PROV },
          tipo: 'moodboard.image.hidden',
          payload: { eventId: EVENTO, imageId },
        },
      ])
    })

    it('un proveedor en ocultarA que vuelve a verla por otra contratación no recibe hidden', async () => {
      // Al encolar perdió la primera contratación; antes de consumir el job se
      // le compartió por la segunda. El worker mira el estado de AHORA.
      await compartir([SEGUNDA_CONTRATACION])

      await procesador.process(job(EVENTO_IMAGEN_CAMBIADA, cambio({ ocultarA: [PROV] })))

      expect(realtime.emitidas.map((e) => e.tipo)).not.toContain(EVENTO_IMAGEN_OCULTA)
      expect(realtime.emitidas).toContainEqual({
        destino: { userId: PROV },
        tipo: 'moodboard.image.changed',
        payload: { eventId: EVENTO, imageId },
      })
    })

    it('notification.created a la campana que aún ve la foto, con eventId y tipo', async () => {
      await compartir([CONTRATACION])

      await procesador.process(
        job(
          EVENTO_IMAGEN_CAMBIADA,
          cambio({ campanaA: [PROV, OTRO_PROV], tipoCampana: 'moodboard.image.shared' }),
        ),
      )

      // OTRO_PROV no la ve ya (revocada entre el encolado y ahora): ni campana
      // por socket ni `changed`; su fila de notificación se queda donde está.
      expect(realtime.emitidas.filter((e) => e.tipo === 'notification.created')).toEqual([
        {
          destino: { userId: PROV },
          tipo: 'notification.created',
          payload: { eventId: EVENTO, type: 'moodboard.image.shared' },
        },
      ])
    })

    it('una foto archivada no llega a ningún proveedor; ocultarA recibe hidden', async () => {
      await compartir([CONTRATACION])
      await repo.fijarArchivo(imageId, PAREJA)

      await procesador.process(job(EVENTO_IMAGEN_CAMBIADA, cambio({ ocultarA: [PROV] })))

      expect(realtime.emitidas).toEqual([
        {
          destino: { eventId: EVENTO },
          tipo: 'moodboard.image.changed',
          payload: { eventId: EVENTO, imageId },
        },
        {
          destino: { userId: PROV },
          tipo: 'moodboard.image.hidden',
          payload: { eventId: EVENTO, imageId },
        },
      ])
    })
  })

  describe('note.created', () => {
    it('llega al evento y a los proveedores que la ven; campana a los participantes', async () => {
      await compartir([CONTRATACION])
      const nota = await repo.crearNota(imageId, PAREJA, 'Me encanta')
      const datos: JobNotaCreada = {
        eventId: EVENTO,
        imageId,
        noteId: nota.id,
        campanaA: [PROV],
      }

      await procesador.process(job(EVENTO_NOTA_CREADA, datos))

      const payload = { eventId: EVENTO, imageId, noteId: nota.id }
      expect(realtime.emitidas).toEqual([
        { destino: { eventId: EVENTO }, tipo: 'moodboard.note.created', payload },
        { destino: { userId: PROV }, tipo: 'moodboard.note.created', payload },
        {
          destino: { userId: PROV },
          tipo: 'notification.created',
          payload: { eventId: EVENTO, type: 'moodboard.note.added' },
        },
      ])
    })

    it('el proveedor revocado que escribió antes no recibe note.created ni la campana', async () => {
      await compartir([CONTRATACION])
      await repo.crearNota(imageId, PROV, 'Puedo hacerlo en blanco')
      const nota = await repo.crearNota(imageId, PAREJA, '¿Y en marfil?')
      // Encolado con PROV en la campana; revocado antes de consumir el job.
      await compartir([])

      await procesador.process(
        job(EVENTO_NOTA_CREADA, {
          eventId: EVENTO,
          imageId,
          noteId: nota.id,
          campanaA: [PROV],
        }),
      )

      expect(realtime.emitidas).toEqual([
        {
          destino: { eventId: EVENTO },
          tipo: 'moodboard.note.created',
          payload: { eventId: EVENTO, imageId, noteId: nota.id },
        },
      ])
    })
  })

  describe('jobs irrecuperables', () => {
    it('un payload roto es irrecuperable con mensaje claro', async () => {
      const roto = procesador.process(job(EVENTO_IMAGEN_CAMBIADA, { eventId: 'no-uuid' }))
      await expect(roto).rejects.toBeInstanceOf(UnrecoverableError)
      await expect(roto).rejects.toThrow(`Payload inválido en el job ${EVENTO_IMAGEN_CAMBIADA}`)

      const rotaNota = procesador.process(job(EVENTO_NOTA_CREADA, null))
      await expect(rotaNota).rejects.toBeInstanceOf(UnrecoverableError)
      await expect(rotaNota).rejects.toThrow(`Payload inválido en el job ${EVENTO_NOTA_CREADA}`)
    })

    it('un tipo de campana desconocido es irrecuperable', async () => {
      await expect(
        procesador.process(
          job(EVENTO_IMAGEN_CAMBIADA, {
            eventId: EVENTO,
            imageId,
            ocultarA: [],
            campanaA: [PROV],
            tipoCampana: 'otra.cosa',
          }),
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError)
    })

    it('un nombre de job desconocido es irrecuperable', async () => {
      const raro = procesador.process(job('moodboard.image.deleted', {}))
      await expect(raro).rejects.toBeInstanceOf(UnrecoverableError)
      await expect(raro).rejects.toThrow(
        'Job desconocido en la cola moodboard: moodboard.image.deleted',
      )
    })
  })

  it('los errores de emisión salen, para que BullMQ reintente', async () => {
    realtime.fallarProximaEmision(new Error('redis caído'))

    await expect(
      procesador.process(
        job(EVENTO_IMAGEN_CAMBIADA, {
          eventId: EVENTO,
          imageId,
          ocultarA: [],
          campanaA: [],
          tipoCampana: null,
        }),
      ),
    ).rejects.toThrow('redis caído')
  })
})

import { Logger } from '@nestjs/common'

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { PresenceEnMemoria } from '@/modules/notifications/infrastructure/presence.fake'
import type { QueuePort } from '@/modules/queue/application/queue.port'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import type { Visor } from '../domain/moodboard'
import { MoodboardRepositoryFake } from '../infrastructure/moodboard.repository.fake'
import {
  COLA_MOODBOARD,
  EVENTO_IMAGEN_CAMBIADA,
  EVENTO_NOTA_CREADA,
  type JobImagenCambiada,
  type JobNotaCreada,
} from './avisos-moodboard'
import {
  ArchivarImagenUseCase,
  CompartirImagenUseCase,
  CrearImagenUseCase,
  CrearNotaUseCase,
  ListarCompartiblesUseCase,
  ListarImagenesUseCase,
  ListarNotasUseCase,
  ObtenerImagenUseCase,
  PrepararSubidaUseCase,
  prefijoMoodboard,
  ResumenUseCase,
} from './moodboard.use-cases'

const EVENTO = 'e1'
const OTRO_EVENTO = 'e2'
const PAREJA = 'u-pareja'
const PLANNER = 'u-planner'
const PROV_A = 'u-prov-a'
const PROV_B = 'u-prov-b'
const CATEGORIA = 'c-flores'
const INACTIVA = 'c-vieja'

const miembro = (userId: string): Visor => ({ tipo: 'miembro', userId })
const proveedor = (userId: string): Visor => ({ tipo: 'proveedor', userId })

/** Cola que siempre falla: Redis caído. */
class ColaRota implements QueuePort {
  enqueue(): Promise<void> {
    return Promise.reject(new Error('Redis caído'))
  }
}

function escenario(opciones: { cola?: QueuePort } = {}) {
  const repo = new MoodboardRepositoryFake()
  repo.sembrarEvento(EVENTO, { status: 'ACTIVE' })
  repo.sembrarEvento(OTRO_EVENTO, { status: 'ACTIVE' })
  repo.sembrarCategoria({ id: CATEGORIA, slug: 'flowers', name: 'Flores', active: true })
  repo.sembrarCategoria({ id: INACTIVA, slug: 'old', name: 'Vieja', active: false })
  for (const [id, name] of [
    [PAREJA, 'Pareja'],
    [PLANNER, 'Planner'],
    [PROV_A, 'Prov A'],
    [PROV_B, 'Prov B'],
  ] as const) {
    repo.sembrarUsuario({ id, name })
  }
  repo.sembrarMiembro({ eventId: EVENTO, userId: PAREJA, role: 'COUPLE', status: 'ACTIVE' })
  repo.sembrarMiembro({ eventId: EVENTO, userId: PLANNER, role: 'PLANNER', status: 'ACTIVE' })
  // PROV_A contratado DOS veces (florista y decorador); PROV_B una; un SHORTLISTED y un externo.
  const contratar = (id: string, userId: string | null, status: 'BOOKED' | 'SHORTLISTED') =>
    repo.sembrarContratacion({
      id,
      eventId: EVENTO,
      userId,
      name: id,
      categoryName: 'Flores',
      status,
    })
  contratar('ev-a1', PROV_A, 'BOOKED')
  contratar('ev-a2', PROV_A, 'BOOKED')
  contratar('ev-b', PROV_B, 'BOOKED')
  contratar('ev-corto', PROV_B, 'SHORTLISTED')
  contratar('ev-externo', null, 'BOOKED')

  const almacen = new ObjectStorageEnMemoria()
  const subidas = new SubidaDeImagenes(almacen)
  const uow = new UnidadDeTrabajoEnMemoria()
  const avisos = new NotificationPortEnMemoria()
  const presencia = new PresenceEnMemoria()
  const memoria = new InMemoryQueueAdapter()
  const cola = opciones.cola ?? memoria

  const crear = new CrearImagenUseCase(repo, subidas, uow, cola)
  const casos = {
    preparar: new PrepararSubidaUseCase(subidas),
    crear,
    listar: new ListarImagenesUseCase(repo),
    obtener: new ObtenerImagenUseCase(repo),
    archivar: new ArchivarImagenUseCase(repo, uow, cola),
    compartir: new CompartirImagenUseCase(repo, uow, avisos, cola),
    notas: new ListarNotasUseCase(repo),
    nota: new CrearNotaUseCase(repo, uow, avisos, cola),
    resumen: new ResumenUseCase(repo, presencia),
    compartibles: new ListarCompartiblesUseCase(repo),
  }

  /** Sube una foto como lo haría el cliente: preparar, PUT al bucket, crear. */
  async function subir(titulo = 'Peonías', eventId = EVENTO) {
    const { key } = await casos.preparar.ejecutar(eventId, 'image/jpeg', 2048)
    almacen.simularSubida(key)
    return await crear.ejecutar(eventId, PAREJA, {
      key,
      title: titulo,
      categoryId: CATEGORIA,
      width: 800,
      height: 600,
    })
  }

  const jobsImagen = () =>
    memoria.encolados
      .filter((e) => e.nombre === EVENTO_IMAGEN_CAMBIADA)
      .map((e) => e.datos as JobImagenCambiada)
  const jobsNota = () =>
    memoria.encolados
      .filter((e) => e.nombre === EVENTO_NOTA_CREADA)
      .map((e) => e.datos as JobNotaCreada)
  const campanas = (tipo: string) => avisos.creadas.filter((c) => c.tipo === tipo)

  return {
    repo,
    almacen,
    uow,
    avisos,
    presencia,
    memoria,
    subir,
    jobsImagen,
    jobsNota,
    campanas,
    ...casos,
  }
}

describe('casos de uso del moodboard', () => {
  describe('preparar subida', () => {
    it('firma la subida bajo el prefijo del evento', async () => {
      const { preparar } = escenario()
      const { key, uploadUrl } = await preparar.ejecutar(EVENTO, 'image/png', 1024)
      expect(key.startsWith(`${prefijoMoodboard(EVENTO)}/`)).toBe(true)
      expect(prefijoMoodboard(EVENTO)).toBe('events/e1/moodboard')
      expect(uploadUrl).toContain(key)
    })

    it('rechaza un tipo que no es imagen con INVALID_IMAGE', async () => {
      const { preparar } = escenario()
      await expect(preparar.ejecutar(EVENTO, 'application/pdf', 1024)).rejects.toMatchObject({
        code: 'INVALID_IMAGE',
      })
    })
  })

  describe('crear foto', () => {
    it('crea la foto con el título recortado y encola image.changed tras confirmar', async () => {
      const { subir, memoria, uow, jobsImagen } = escenario()
      const imagen = await subir('  Peonías  ')
      expect(imagen.title).toBe('Peonías')
      expect(imagen.uploadedBy.id).toBe(PAREJA)
      expect(uow.transacciones).toBe(1)
      expect(jobsImagen()).toEqual([
        { eventId: EVENTO, imageId: imagen.id, ocultarA: [], campanaA: [], tipoCampana: null },
      ])
      expect(memoria.encolados[0]?.cola).toBe(COLA_MOODBOARD)
      const jobId = memoria.encolados[0]?.jobId ?? ''
      expect(jobId.startsWith(`moodboard-img-${imagen.id}-`)).toBe(true)
      expect(jobId.slice(`moodboard-img-${imagen.id}-`.length)).toMatch(/^\d+$/)
    })

    it('con el cupo lleno lanza MOODBOARD_IMAGE_LIMIT y no crea nada', async () => {
      const { repo, almacen, preparar, crear } = escenario()
      for (let i = 0; i < 500; i++) {
        await repo.crearImagen({
          eventId: EVENTO,
          categoryId: CATEGORIA,
          title: `f${i}`,
          storageKey: `k${i}`,
          width: 1,
          height: 1,
          uploadedById: PAREJA,
        })
      }
      const { key } = await preparar.ejecutar(EVENTO, 'image/jpeg', 10)
      almacen.simularSubida(key)
      await expect(
        crear.ejecutar(EVENTO, PAREJA, {
          key,
          title: 'x',
          categoryId: CATEGORIA,
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: 'MOODBOARD_IMAGE_LIMIT', httpStatus: 422 })
      expect(repo.imagenes).toHaveLength(500)
    })

    it('con la categoría inactiva lanza MOODBOARD_INVALID_CATEGORY', async () => {
      const { almacen, preparar, crear, repo } = escenario()
      const { key } = await preparar.ejecutar(EVENTO, 'image/jpeg', 10)
      almacen.simularSubida(key)
      await expect(
        crear.ejecutar(EVENTO, PAREJA, {
          key,
          title: 'x',
          categoryId: INACTIVA,
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: 'MOODBOARD_INVALID_CATEGORY', httpStatus: 422 })
      await expect(
        crear.ejecutar(EVENTO, PAREJA, {
          key,
          title: 'x',
          categoryId: 'no-existe',
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: 'MOODBOARD_INVALID_CATEGORY' })
      expect(repo.imagenes).toHaveLength(0)
    })

    it('con una key de otro prefijo (otro evento) lanza INVALID_UPLOAD y no crea nada', async () => {
      const { almacen, preparar, crear, repo, memoria, uow } = escenario()
      const { key } = await preparar.ejecutar(OTRO_EVENTO, 'image/jpeg', 10)
      almacen.simularSubida(key)
      await expect(
        crear.ejecutar(EVENTO, PAREJA, {
          key,
          title: 'x',
          categoryId: CATEGORIA,
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_UPLOAD', httpStatus: 422 })
      expect(repo.imagenes).toHaveLength(0)
      expect(memoria.encolados).toHaveLength(0)
      // R2 se consulta antes de bloquear el evento: si dice que no, ni se abre la transacción.
      expect(uow.transacciones).toBe(0)
    })

    it('si el objeto no llegó al bucket lanza INVALID_UPLOAD sin abrir la transacción', async () => {
      const { preparar, crear, repo, memoria, uow } = escenario()
      const { key } = await preparar.ejecutar(EVENTO, 'image/jpeg', 10)
      await expect(
        crear.ejecutar(EVENTO, PAREJA, {
          key,
          title: 'x',
          categoryId: CATEGORIA,
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_UPLOAD' })
      expect(repo.imagenes).toHaveLength(0)
      expect(memoria.encolados).toHaveLength(0)
      expect(uow.transacciones).toBe(0)
    })

    it('un título vacío tras el recorte lanza INVALID_TITLE', async () => {
      const { almacen, preparar, crear } = escenario()
      const { key } = await preparar.ejecutar(EVENTO, 'image/jpeg', 10)
      almacen.simularSubida(key)
      await expect(
        crear.ejecutar(EVENTO, PAREJA, {
          key,
          title: '   ',
          categoryId: CATEGORIA,
          width: 1,
          height: 1,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_TITLE' })
    })
  })

  describe('listar y obtener', () => {
    it('el proveedor sólo ve lo compartido con él; una foto no compartida es 404', async () => {
      const { subir, compartir, listar, obtener } = escenario()
      const suya = await subir('Suya')
      const ajena = await subir('Ajena')
      await compartir.ejecutar(EVENTO, suya.id, PAREJA, ['ev-a1'])

      expect((await listar.ejecutar(EVENTO, proveedor(PROV_A), false)).map((i) => i.id)).toEqual([
        suya.id,
      ])
      expect((await listar.ejecutar(EVENTO, miembro(PLANNER), false)).map((i) => i.id)).toEqual([
        ajena.id,
        suya.id,
      ])
      await expect(obtener.ejecutar(EVENTO, ajena.id, proveedor(PROV_A))).rejects.toMatchObject({
        code: 'MOODBOARD_IMAGE_NOT_FOUND',
        httpStatus: 404,
      })
      expect((await obtener.ejecutar(EVENTO, suya.id, proveedor(PROV_A))).id).toBe(suya.id)
    })

    it('una foto de otro evento es 404 aunque exista', async () => {
      const { subir, obtener } = escenario()
      const imagen = await subir('Otra', OTRO_EVENTO)
      await expect(obtener.ejecutar(EVENTO, imagen.id, miembro(PAREJA))).rejects.toMatchObject({
        code: 'MOODBOARD_IMAGE_NOT_FOUND',
      })
    })

    it('las archivadas se listan aparte y sólo para miembros', async () => {
      const { subir, archivar, listar } = escenario()
      const imagen = await subir()
      await archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)
      expect(await listar.ejecutar(EVENTO, miembro(PAREJA), false)).toEqual([])
      expect((await listar.ejecutar(EVENTO, miembro(PAREJA), true)).map((i) => i.id)).toEqual([
        imagen.id,
      ])
      expect(await listar.ejecutar(EVENTO, proveedor(PROV_A), true)).toEqual([])
    })

    it('las contrataciones compartibles son las BOOKED con ficha', async () => {
      const { compartibles } = escenario()
      expect((await compartibles.ejecutar(EVENTO)).map((c) => c.eventVendorId)).toEqual([
        'ev-a1',
        'ev-a2',
        'ev-b',
      ])
    })
  })

  describe('archivar', () => {
    it('al archivar, el job lleva en ocultarA a los proveedores que la veían', async () => {
      const { subir, compartir, archivar, jobsImagen } = escenario()
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-a1', 'ev-a2', 'ev-b'])
      const archivada = await archivar.ejecutar(EVENTO, imagen.id, PLANNER, true)
      expect(archivada.archivedAt).not.toBeNull()
      expect(jobsImagen().at(-1)).toEqual({
        eventId: EVENTO,
        imageId: imagen.id,
        ocultarA: [PROV_A, PROV_B],
        campanaA: [],
        tipoCampana: null,
      })
    })

    it('es idempotente: archivar una archivada no encola nada', async () => {
      const { subir, archivar, memoria } = escenario()
      const imagen = await subir()
      await archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)
      const antes = memoria.encolados.length
      const otra = await archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)
      expect(otra.archivedAt).not.toBeNull()
      expect(memoria.encolados).toHaveLength(antes)
    })

    it('recuperar la deja activa y el job no oculta a nadie', async () => {
      const { subir, compartir, archivar, jobsImagen } = escenario()
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      await archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)
      const recuperada = await archivar.ejecutar(EVENTO, imagen.id, PAREJA, false)
      expect(recuperada.archivedAt).toBeNull()
      expect(jobsImagen().at(-1)?.ocultarA).toEqual([])
    })

    it('una foto de otro evento es 404', async () => {
      const { subir, archivar } = escenario()
      const imagen = await subir('x', OTRO_EVENTO)
      await expect(archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)).rejects.toMatchObject({
        code: 'MOODBOARD_IMAGE_NOT_FOUND',
      })
    })
  })

  describe('compartir', () => {
    it('con una contratación SHORTLISTED o externa lanza 422 con details.eventVendorIds', async () => {
      const { subir, compartir, repo } = escenario()
      const imagen = await subir()
      await expect(
        compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-a1', 'ev-corto', 'ev-externo', 'ev-x']),
      ).rejects.toMatchObject({
        code: 'MOODBOARD_VENDOR_NOT_SHAREABLE',
        httpStatus: 422,
        details: { eventVendorIds: ['ev-corto', 'ev-externo', 'ev-x'] },
      })
      expect(repo.comparticiones).toHaveLength(0)
    })

    it('no se comparte una foto archivada', async () => {
      const { subir, archivar, compartir } = escenario()
      const imagen = await subir()
      await archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)
      await expect(compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])).rejects.toMatchObject({
        code: 'MOODBOARD_IMAGE_ARCHIVED',
      })
    })

    it('el alta crea la campana moodboard.image.shared y el job la anuncia', async () => {
      const { subir, compartir, campanas, jobsImagen, uow } = escenario()
      const imagen = await subir()
      const compartida = await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      expect(compartida.sharedWith.map((s) => s.eventVendorId)).toEqual(['ev-b'])
      expect(campanas('moodboard.image.shared')).toEqual([
        {
          eventId: EVENTO,
          userId: PROV_B,
          tipo: 'moodboard.image.shared',
          payload: { imageId: imagen.id },
        },
      ])
      expect(uow.transacciones).toBe(2)
      expect(jobsImagen().at(-1)).toEqual({
        eventId: EVENTO,
        imageId: imagen.id,
        ocultarA: [],
        campanaA: [PROV_B],
        tipoCampana: 'moodboard.image.shared',
      })
    })

    it('revocar y volver a compartir hace sonar la campana las dos veces', async () => {
      const { subir, compartir, campanas, repo } = escenario()
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, [])
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      expect(campanas('moodboard.image.shared').map((c) => c.userId)).toEqual([PROV_B, PROV_B])
      // La fila se reaviva, no se duplica.
      expect(repo.comparticiones).toHaveLength(1)
    })

    it('compartir con [] desde [a] pone en ocultarA al usuario de a', async () => {
      const { subir, compartir, jobsImagen } = escenario()
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, [])
      expect(jobsImagen().at(-1)).toEqual({
        eventId: EVENTO,
        imageId: imagen.id,
        ocultarA: [PROV_B],
        campanaA: [],
        tipoCampana: null,
      })
    })

    it('quien la sigue viendo por otra contratación no entra en ocultarA (unión)', async () => {
      const { subir, compartir, jobsImagen, obtener } = escenario()
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-a1', 'ev-a2'])
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-a2'])
      expect(jobsImagen().at(-1)?.ocultarA).toEqual([])
      expect((await obtener.ejecutar(EVENTO, imagen.id, proveedor(PROV_A))).id).toBe(imagen.id)
    })

    it('fijar el mismo conjunto no encola ni hace sonar nada', async () => {
      const { subir, compartir, memoria, campanas } = escenario()
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      const antes = memoria.encolados.length
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      expect(memoria.encolados).toHaveLength(antes)
      expect(campanas('moodboard.image.shared')).toHaveLength(1)
    })
  })

  describe('notas', () => {
    it('en una foto archivada lanza MOODBOARD_IMAGE_ARCHIVED', async () => {
      const { subir, archivar, nota } = escenario()
      const imagen = await subir()
      await archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)
      await expect(nota.ejecutar(EVENTO, imagen.id, miembro(PAREJA), 'Hola')).rejects.toMatchObject(
        { code: 'MOODBOARD_IMAGE_ARCHIVED', httpStatus: 422 },
      )
    })

    it('el proveedor no escribe ni lee notas de una foto que no se le compartió', async () => {
      const { subir, nota, notas } = escenario()
      const imagen = await subir()
      await expect(
        nota.ejecutar(EVENTO, imagen.id, proveedor(PROV_A), 'Hola'),
      ).rejects.toMatchObject({ code: 'MOODBOARD_IMAGE_NOT_FOUND' })
      await expect(notas.ejecutar(EVENTO, imagen.id, proveedor(PROV_A))).rejects.toMatchObject({
        code: 'MOODBOARD_IMAGE_NOT_FOUND',
      })
    })

    it('una nota vacía lanza INVALID_NOTE', async () => {
      const { subir, nota } = escenario()
      const imagen = await subir()
      await expect(nota.ejecutar(EVENTO, imagen.id, miembro(PAREJA), '  ')).rejects.toMatchObject({
        code: 'INVALID_NOTE',
      })
    })

    it('la campana va a los participantes sin el autor ni el proveedor revocado', async () => {
      const { subir, compartir, nota, notas, campanas, jobsNota } = escenario()
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-a1', 'ev-b'])
      await nota.ejecutar(EVENTO, imagen.id, proveedor(PROV_A), 'Primera de A')
      await nota.ejecutar(EVENTO, imagen.id, miembro(PLANNER), 'Del planner')
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])

      const creada = await nota.ejecutar(EVENTO, imagen.id, proveedor(PROV_B), '  De B  ')
      expect(creada.body).toBe('De B')
      expect(creada.author.id).toBe(PROV_B)

      const ultimas = campanas('moodboard.note.added').filter(
        (c) => (c.payload as { noteId: string }).noteId === creada.id,
      )
      expect(ultimas.map((c) => c.userId).sort()).toEqual([PAREJA, PLANNER])
      expect(ultimas[0]?.payload).toEqual({ imageId: imagen.id, noteId: creada.id })
      expect(jobsNota().at(-1)).toEqual({
        eventId: EVENTO,
        imageId: imagen.id,
        noteId: creada.id,
        campanaA: [PAREJA, PLANNER],
      })
      // El proveedor que sigue viéndola lee todas las notas, en orden cronológico.
      expect(
        (await notas.ejecutar(EVENTO, imagen.id, proveedor(PROV_B))).map((n) => n.body),
      ).toEqual(['Primera de A', 'Del planner', 'De B'])
    })

    it('el job de la nota usa un jobId derivado de la nota', async () => {
      const { subir, nota, memoria } = escenario()
      const imagen = await subir()
      const creada = await nota.ejecutar(EVENTO, imagen.id, miembro(PAREJA), 'Hola')
      expect(memoria.encolados.at(-1)?.jobId).toBe(`moodboard-note-${creada.id}`)
      expect(memoria.encolados.at(-1)?.cola).toBe('moodboard')
    })

    it('un miembro lee las notas de una foto archivada', async () => {
      const { subir, nota, archivar, notas } = escenario()
      const imagen = await subir()
      await nota.ejecutar(EVENTO, imagen.id, miembro(PAREJA), 'Antes de archivar')
      await archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)
      expect(await notas.ejecutar(EVENTO, imagen.id, miembro(PLANNER))).toHaveLength(1)
    })
  })

  describe('resumen', () => {
    it('marca en línea a los colaboradores con socket vivo', async () => {
      const { subir, compartir, resumen, presencia } = escenario()
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      await presencia.conectar(PROV_B, 's1', new Date())
      const r = await resumen.ejecutar(EVENTO, miembro(PAREJA))
      expect(r.collaborators.map((c) => c.userId)).toEqual([PAREJA, PLANNER, PROV_B])
      expect([...r.online]).toEqual([PROV_B])
      expect(r.stats).toEqual({ images: 1, notes: 0 })
    })

    it('si la presencia falla, el resumen sale con nadie en línea', async () => {
      const { subir, resumen, presencia } = escenario()
      await subir()
      presencia.fallar = new Error('Redis caído')
      const r = await resumen.ejecutar(EVENTO, miembro(PAREJA))
      expect(r.online.size).toBe(0)
      expect(r.stats.images).toBe(1)
    })
  })

  describe('fallo de la cola', () => {
    let aviso: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    })
    afterEach(() => {
      vi.restoreAllMocks()
    })

    it('no tumba crear, archivar, compartir ni escribir nota', async () => {
      const { subir, archivar, compartir, nota, repo, campanas } = escenario({
        cola: new ColaRota(),
      })
      const imagen = await subir()
      await compartir.ejecutar(EVENTO, imagen.id, PAREJA, ['ev-b'])
      await nota.ejecutar(EVENTO, imagen.id, miembro(PAREJA), 'Hola')
      await archivar.ejecutar(EVENTO, imagen.id, PAREJA, true)
      expect(repo.imagenes[0]?.archivedAt).not.toBeNull()
      expect(repo.notas).toHaveLength(1)
      expect(campanas('moodboard.image.shared')).toHaveLength(1)
      expect(aviso).toHaveBeenCalledTimes(4)
    })
  })
})

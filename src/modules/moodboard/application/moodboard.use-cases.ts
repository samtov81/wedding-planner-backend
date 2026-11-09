import { Inject, Injectable, Logger } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'
import {
  NOTIFICATION_PORT,
  type NotificationPort,
} from '@/modules/notifications/application/notification.port'
import { PRESENCE_PORT, type PresencePort } from '@/modules/notifications/application/presence.port'
import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import {
  SubidaDeImagenes,
  type SubidaPreparada,
} from '@/modules/storage/application/subida-de-imagenes'

import {
  exigirActiva,
  exigirCupo,
  normalizarNota,
  normalizarTitulo,
  type Visor,
} from '../domain/moodboard'
import {
  CategoriaInvalidaError,
  ImagenNoEncontradaError,
  ProveedorNoCompartibleError,
} from '../domain/moodboard-errors'
import { encolarAvisoImagen, encolarAvisoNota } from './avisos-moodboard'
import {
  type ContratacionCompartible,
  type ImagenDeMoodboard,
  MOODBOARD_REPOSITORY,
  type MoodboardRepository,
  type NotaDeMoodboard,
  type ResumenCrudo,
} from './moodboard.repository'

/**
 * Casos de uso del moodboard (spec 2026-11-09 §4, §6, §7). Todos reciben un
 * `Visor` (o, en las acciones sólo de miembros, el `userId`), nunca el
 * `EventAccess`: el controlador ya pasó el guard y traduce el acceso. Quién
 * VE cada foto lo decide el repositorio (una sola copia de la regla de unión
 * de contrataciones); aquí sólo se convierte un `null` en 404.
 *
 * Un fichero para todos, como `my-vendor-profile.use-cases.ts`: son pequeños y
 * comparten las mismas dependencias y el mismo patrón "escribir en una unidad
 * de trabajo, encolar tras el commit".
 */

/** Prefijo de las keys de R2 de un evento (spec 2026-11-09 §6). */
export const prefijoMoodboard = (eventId: string): string => `events/${eventId}/moodboard`

/** Las acciones de escritura de miembros miran la foto como miembro: ven también las archivadas. */
const comoMiembro = (userId: string): Visor => ({ tipo: 'miembro', userId })

async function exigirImagen(
  repo: MoodboardRepository,
  eventId: string,
  imageId: string,
  visor: Visor,
): Promise<ImagenDeMoodboard> {
  const imagen = await repo.buscarImagen(eventId, imageId, visor)
  if (imagen === null) throw new ImagenNoEncontradaError()
  return imagen
}

/** Firma la subida directa a R2 bajo el prefijo del evento (JPG/PNG/WebP ≤ 10 MB). */
@Injectable()
export class PrepararSubidaUseCase {
  constructor(private readonly subidas: SubidaDeImagenes) {}

  ejecutar(eventId: string, contentType: string, bytes: number): Promise<SubidaPreparada> {
    return this.subidas.preparar(prefijoMoodboard(eventId), contentType, bytes)
  }
}

export interface DatosCrearImagen {
  key: string
  title: string
  categoryId: string
  width: number
  height: number
}

/**
 * Da de alta la foto ya subida, en este orden: comprobar en R2 → (unidad de
 * trabajo: bloquear el evento y contar → tope → categoría activa → insertar).
 * El tope sólo es fiable bajo el `FOR UPDATE`: dos altas concurrentes con 499
 * fotos se serializan y la segunda ve 500.
 *
 * `confirmar` (un HEAD a R2) va ANTES de abrir la unidad de trabajo: dentro,
 * tras el `SELECT … FOR UPDATE` de la fila del evento, el viaje de red
 * alargaría el bloqueo y con él cualquier INSERT con FK a ese evento (notas,
 * invitados, gastos…) esperaría a R2. Si R2 dice que no, no se abre la
 * transacción ni se crea nada. El precio: una petición que el tope o la
 * categoría van a rechazar también hace el viaje a R2 (y, si el objeto no
 * cumple las reglas, lo borra, que es lo correcto igualmente: nadie lo usaría).
 * Alternativa descartada: confirmar dentro, tras el tope y la categoría, para
 * ahorrar ese viaje a las peticiones condenadas a costa de tener la fila del
 * evento bloqueada durante I/O de red.
 *
 * Tras el commit se encola `image.changed` sin `ocultarA` ni campana: una foto
 * nueva no está compartida con nadie todavía.
 */
@Injectable()
export class CrearImagenUseCase {
  private readonly registro = new Logger(CrearImagenUseCase.name)

  constructor(
    @Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository,
    private readonly subidas: SubidaDeImagenes,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    eventId: string,
    userId: string,
    datos: DatosCrearImagen,
  ): Promise<ImagenDeMoodboard> {
    const title = normalizarTitulo(datos.title)
    await this.subidas.confirmar(prefijoMoodboard(eventId), datos.key)
    const imagen = await this.unidadDeTrabajo.ejecutar(async () => {
      exigirCupo(await this.repo.bloquearYContar(eventId))
      if (!(await this.repo.categoriaActiva(datos.categoryId))) throw new CategoriaInvalidaError()
      return await this.repo.crearImagen({
        eventId,
        categoryId: datos.categoryId,
        title,
        storageKey: datos.key,
        width: datos.width,
        height: datos.height,
        uploadedById: userId,
      })
    })
    await encolarAvisoImagen(this.cola, this.registro, {
      eventId,
      imageId: imagen.id,
      ocultarA: [],
      campanaA: [],
      tipoCampana: null,
    })
    return imagen
  }
}

/**
 * Fotos activas (o archivadas) que el visor ve, más nuevas primero. Para un
 * proveedor `archivadas = true` devuelve `[]`; el 403 de esa combinación es
 * del controlador (contrato), no de aquí.
 */
@Injectable()
export class ListarImagenesUseCase {
  constructor(@Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository) {}

  ejecutar(eventId: string, visor: Visor, archivadas: boolean): Promise<ImagenDeMoodboard[]> {
    return this.repo.listarImagenes(eventId, visor, archivadas)
  }
}

/** Una foto, o 404 si no existe en el evento o el visor no la ve. */
@Injectable()
export class ObtenerImagenUseCase {
  constructor(@Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository) {}

  ejecutar(eventId: string, imageId: string, visor: Visor): Promise<ImagenDeMoodboard> {
    return exigirImagen(this.repo, eventId, imageId, visor)
  }
}

/**
 * Archiva o recupera (sólo miembros). Idempotente: pedir el estado que ya
 * tiene devuelve la foto sin escribir ni encolar.
 *
 * Al archivar, `ocultarA` son los proveedores que la veían ANTES del cambio:
 * después, `proveedoresQueVen` ya no devuelve a nadie (una archivada no la ve
 * ningún proveedor), así que hay que leerlo antes y en la misma transacción.
 * Al recuperar no se oculta a nadie; quién vuelve a verla lo calcula el worker
 * con el estado actual. Bloquea la fila de la foto antes de leerla (ver
 * `bloquearImagen` en el puerto): una compartición concurrente que se cuele
 * entre la lectura de `proveedoresQueVen` y el archivado dejaría a ese
 * proveedor fuera de `ocultarA`.
 */
@Injectable()
export class ArchivarImagenUseCase {
  private readonly registro = new Logger(ArchivarImagenUseCase.name)

  constructor(
    @Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    eventId: string,
    imageId: string,
    userId: string,
    archivada: boolean,
  ): Promise<ImagenDeMoodboard> {
    const visor = comoMiembro(userId)
    const resultado = await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearImagen(eventId, imageId)
      const imagen = await exigirImagen(this.repo, eventId, imageId, visor)
      if ((imagen.archivedAt !== null) === archivada) return { imagen, ocultarA: null }
      const ocultarA = archivada ? await this.repo.proveedoresQueVen(imageId) : []
      await this.repo.fijarArchivo(imageId, archivada ? userId : null)
      return { imagen: await exigirImagen(this.repo, eventId, imageId, visor), ocultarA }
    })
    if (resultado.ocultarA !== null) {
      await encolarAvisoImagen(this.cola, this.registro, {
        eventId,
        imageId,
        ocultarA: resultado.ocultarA,
        campanaA: [],
        tipoCampana: null,
      })
    }
    return resultado.imagen
  }
}

/**
 * Fija el conjunto COMPLETO de contrataciones con las que se comparte la foto
 * (sólo miembros, foto activa). Cualquier id que no sea una contratación
 * `BOOKED` con ficha de ESTE evento → 422 con todos los ids rechazados; no se
 * aplica nada parcialmente.
 *
 * Dentro de la unidad de trabajo:
 *  - `fijarComparticion` devuelve altas (creadas o reavivadas) y bajas.
 *  - Campana `moodboard.image.shared` a los usuarios de las altas. Reavivar
 *    cuenta como alta: revocar y volver a compartir vuelve a avisar.
 *  - `ocultarA` = usuarios de las bajas que, DESPUÉS del cambio, ya no la ven.
 *    Un proveedor contratado dos veces que pierde una contratación pero
 *    conserva la otra sigue viéndola (unión, spec 2026-11-09 §4) y no debe
 *    recibir `image.hidden`. Por eso `proveedoresQueVen` se lee tras escribir,
 *    dentro de la transacción (el repositorio ve sus propias escrituras).
 *
 * Si el conjunto pedido es el vigente no hay nada que avisar y no se encola.
 *
 * Lo primero de la transacción es `bloquearImagen` (igual en archivar y en
 * escribir nota): las tres escrituras comparten el invariante "archivada =
 * sin comparticiones ni notas nuevas" y se serializan sobre la fila de la
 * foto; sin él, una compartición que leyó la foto activa antes de que un
 * archivado concurrente confirmara escribiría sobre una archivada, y dos
 * comparticiones de la misma contratación chocarían en el upsert (P2002).
 */
@Injectable()
export class CompartirImagenUseCase {
  private readonly registro = new Logger(CompartirImagenUseCase.name)

  constructor(
    @Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(NOTIFICATION_PORT) private readonly avisos: NotificationPort,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    eventId: string,
    imageId: string,
    userId: string,
    eventVendorIds: string[],
  ): Promise<ImagenDeMoodboard> {
    const visor = comoMiembro(userId)
    const pedidos = [...new Set(eventVendorIds)]
    const resultado = await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearImagen(eventId, imageId)
      exigirActiva(await exigirImagen(this.repo, eventId, imageId, visor))
      const compartibles = new Set(
        (await this.repo.listarCompartibles(eventId)).map((c) => c.eventVendorId),
      )
      const rechazados = pedidos.filter((id) => !compartibles.has(id))
      if (rechazados.length > 0) throw new ProveedorNoCompartibleError(rechazados)

      const { altas, bajas } = await this.repo.fijarComparticion(imageId, pedidos, userId)
      const campanaA = await this.repo.usuariosDeContrataciones(altas)
      if (campanaA.length > 0) {
        await this.avisos.crearParaUsuarios(eventId, campanaA, 'moodboard.image.shared', {
          imageId,
        })
      }
      const siguenViendo = new Set(await this.repo.proveedoresQueVen(imageId))
      const ocultarA = (await this.repo.usuariosDeContrataciones(bajas)).filter(
        (u) => !siguenViendo.has(u),
      )
      return {
        imagen: await exigirImagen(this.repo, eventId, imageId, visor),
        cambio: altas.length > 0 || bajas.length > 0,
        ocultarA,
        campanaA,
      }
    })
    if (resultado.cambio) {
      await encolarAvisoImagen(this.cola, this.registro, {
        eventId,
        imageId,
        ocultarA: resultado.ocultarA,
        campanaA: resultado.campanaA,
        tipoCampana: resultado.campanaA.length > 0 ? 'moodboard.image.shared' : null,
      })
    }
    return resultado.imagen
  }
}

/** Contrataciones con las que se puede compartir (selector "Share with Vendor"). */
@Injectable()
export class ListarCompartiblesUseCase {
  constructor(@Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository) {}

  ejecutar(eventId: string): Promise<ContratacionCompartible[]> {
    return this.repo.listarCompartibles(eventId)
  }
}

/**
 * Notas de una foto en orden cronológico. Basta con que el visor vea la foto:
 * un miembro lee también las de una archivada (sólo lectura), y un proveedor
 * al que se le vuelve a compartir recupera las antiguas, incluidas las suyas.
 */
@Injectable()
export class ListarNotasUseCase {
  constructor(@Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository) {}

  async ejecutar(eventId: string, imageId: string, visor: Visor): Promise<NotaDeMoodboard[]> {
    await exigirImagen(this.repo, eventId, imageId, visor)
    return await this.repo.listarNotas(imageId)
  }
}

/**
 * Escribe una nota (miembro, o proveedor con la foto compartida) en una foto
 * activa. Dentro de la unidad de trabajo crea la nota y la campana
 * `moodboard.note.added` a los participantes menos el autor; `participantes`
 * ya filtra por quién ve la foto ahora, así que un proveedor revocado que
 * escribió antes no recibe nada. Tras el commit encola `note.created` con esos
 * mismos destinatarios de campana.
 *
 * Bloquea la fila de la foto antes de leerla (ver `bloquearImagen` en el
 * puerto): una nota que empezó antes de que un archivado concurrente
 * confirmara espera y lo ve, en vez de escribir sobre una foto archivada.
 *
 * Orden de los errores: 404 antes que 422, para que un proveedor no distinga
 * una foto que no ve de una que existe pero está archivada (tampoco la ve).
 */
@Injectable()
export class CrearNotaUseCase {
  private readonly registro = new Logger(CrearNotaUseCase.name)

  constructor(
    @Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
    @Inject(NOTIFICATION_PORT) private readonly avisos: NotificationPort,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(
    eventId: string,
    imageId: string,
    visor: Visor,
    body: string,
  ): Promise<NotaDeMoodboard> {
    const { nota, campanaA } = await this.unidadDeTrabajo.ejecutar(async () => {
      await this.repo.bloquearImagen(eventId, imageId)
      exigirActiva(await exigirImagen(this.repo, eventId, imageId, visor))
      const cuerpo = normalizarNota(body)
      const nota = await this.repo.crearNota(imageId, visor.userId, cuerpo)
      const campanaA = await this.repo.participantes(imageId, visor.userId)
      if (campanaA.length > 0) {
        await this.avisos.crearParaUsuarios(eventId, campanaA, 'moodboard.note.added', {
          imageId,
          noteId: nota.id,
        })
      }
      return { nota, campanaA }
    })
    await encolarAvisoNota(this.cola, this.registro, {
      eventId,
      imageId,
      noteId: nota.id,
      campanaA,
    })
    return nota
  }
}

/**
 * Resumen del tablero con la presencia de cada colaborador (spec 2026-11-09 §8).
 * La presencia es un adorno: si Redis falla se registra y el resumen sale con
 * nadie en línea, en vez de tumbar la pantalla entera por un punto verde.
 * Alternativa descartada: propagar el error, que convertiría una caída de
 * Redis en un 500 del moodboard.
 */
@Injectable()
export class ResumenUseCase {
  private readonly registro = new Logger(ResumenUseCase.name)

  constructor(
    @Inject(MOODBOARD_REPOSITORY) private readonly repo: MoodboardRepository,
    @Inject(PRESENCE_PORT) private readonly presencia: PresencePort,
  ) {}

  async ejecutar(eventId: string, visor: Visor): Promise<ResumenCrudo & { online: Set<string> }> {
    const crudo = await this.repo.resumen(eventId, visor)
    const ids = crudo.collaborators.map((c) => c.userId)
    let online: Set<string>
    try {
      online = await this.presencia.enLinea(ids, new Date())
    } catch (error) {
      this.registro.warn(
        `Presencia no disponible para el resumen eventId=${eventId}: ` +
          (error instanceof Error ? error.message : String(error)),
      )
      online = new Set()
    }
    return { ...crudo, online }
  }
}

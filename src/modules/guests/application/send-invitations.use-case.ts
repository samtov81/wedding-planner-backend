import { Inject, Injectable, Logger } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { caducidadInvitacion, generarTokenInvitacion } from '../domain/invitation'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'
import { INVITATION_REPOSITORY, type InvitationRepository } from './invitation.repository'

/**
 * `ENQUEUE_FAILED` es el tercer motivo: el invitado DEBÍA recibir invitación y
 * algo falló al crearla o encolarla. Va en `skipped` y no en una lista aparte a
 * propósito: la forma `{ queued, skipped }` es la del contrato de la tarea, y un
 * cliente que ya recorre `skipped` por motivo lo ve sin cambiar de forma. El
 * motivo distingue "no se le manda por diseño" (NO_EMAIL, ALREADY_RESPONDED)
 * de "no se le ha podido mandar" (ENQUEUE_FAILED). Que reintentarlo sirva
 * depende de la causa: una caída de Redis, sí; un invitado borrado a mitad
 * (`P2003`), no. La causa queda en el log, no en la respuesta.
 */
export type MotivoOmision = 'NO_EMAIL' | 'ALREADY_RESPONDED' | 'ENQUEUE_FAILED'

export interface ResultadoEnvio {
  queued: Array<{ guestId: string; invitationId: string }>
  skipped: Array<{ guestId: string; reason: MotivoOmision }>
}

/**
 * DESIGN-GAP: el brief dice cola `email`. Se usa una cola PROPIA por orden del
 * controlador (ruling C17): `email` ya tiene otros productores (`verify-email`
 * del registro, `event-invitation` de invitar miembros) sin worker todavía, y
 * este worker, al tomar sus jobs y retornar, los marcaría COMPLETADOS y BullMQ
 * los borraría sin enviarse. Sin nadie escuchando `email`, esperan en `waiting`
 * a su worker, que es lo correcto. El nombre del job y el payload no cambian.
 */
export const COLA_INVITACIONES = 'invitations' as const
export const JOB_INVITACION = 'guest-invitation'

/** Payload del job. Lo consumen el worker (aquí) y el RSVP público (Tarea 14). */
export interface PayloadInvitacion {
  invitationId: string
  token: string
  requestId: string
}

/**
 * Edad a partir de la cual BullMQ PUEDE recortar un fallido de esta cola. No es
 * una cota: el recorte sólo corre cuando otro job de la cola falla después (ver
 * `bullmq-queue.adapter.ts`), así que el último lote de fallos se queda en
 * Redis sin límite. Lo que sí protege el token es que el worker CADUCA la
 * invitación cuando el job agota sus intentos (ruling C18): el token que quede
 * en el payload deja de servir, dure lo que dure allí.
 */
export const RETENCION_FALLIDOS_MS = 7 * 86_400_000

/**
 * jobId derivado de la invitación. Encolar dos veces el MISMO `invitationId`
 * deja un solo job, pero a este nivel eso no ocurre nunca: cada llamada crea
 * invitaciones con ids nuevos.
 *
 * HUECO CONOCIDO (ruling C16): dos envíos masivos seguidos (un doble clic)
 * crean dos invitaciones por invitado y encolan dos jobs, y el invitado recibe
 * dos correos. Cerrarlo exige decidir qué identifica a una invitación en el
 * tiempo (¿una por invitado y evento? ¿una por campaña?), diseño de dominio que
 * el plan no fijó y que la Tarea 14 puede condicionar. Hoy lo único que evita
 * duplicados es la guarda de estado del worker, que sólo cubre la REENTREGA del
 * mismo job.
 */
export function jobIdDeInvitacion(invitationId: string): string {
  // Separador `-`, NUNCA `:`: BullMQ usa los dos puntos como separador de
  // claves de Redis y rechaza el job ("Custom Id cannot contain :"). Con `:`
  // esto revienta en runtime contra Redis real, no en los tests con el doble.
  return `invitation-${invitationId}`
}

@Injectable()
export class SendInvitationsUseCase {
  constructor(
    @Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository,
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  /**
   * `Logger` de Nest y no el pino de `shared/logging`: cablear ese es de la
   * Tarea 16; cuando llegue, el `Logger` de Nest se redirige a él sin tocar esto.
   */
  private readonly registro = new Logger(SendInvitationsUseCase.name)

  async ejecutar(eventId: string, requestId = ''): Promise<ResultadoEnvio> {
    const todos = await this.invitados.listarTodos(eventId)
    const resultado: ResultadoEnvio = { queued: [], skipped: [] }

    for (const invitado of todos) {
      // Un invitado sin email NO puede recibir invitación. Se REPORTA, no se
      // filtra: quien pulsa "enviar a los 150" tiene derecho a saber que 40 no
      // van a recibir nada.
      if (invitado.email === null) {
        resultado.skipped.push({ guestId: invitado.id, reason: 'NO_EMAIL' })
        continue
      }

      if (invitado.rsvp !== 'PENDING') {
        resultado.skipped.push({ guestId: invitado.id, reason: 'ALREADY_RESPONDED' })
        continue
      }

      // Un fallo aislado NO tumba el lote. Sin esto, el `create` del invitado
      // nº 80 que lanza (p. ej. borrado a mitad → 404) abortaría la llamada con
      // 79 correos ya en camino, y quien llama recibiría un 404 de un envío que
      // en su mayor parte SÍ se hizo. El detalle del error no sale en la
      // respuesta: el motivo basta para reintentar y no filtra internos.
      //
      // DESIGN-GAP: si `crear` va bien y `enqueue` falla (Redis caído), la fila
      // queda en QUEUED sin job que la procese. Se reporta como ENQUEUE_FAILED,
      // pero la fila huérfana no se limpia aquí.
      try {
        const invitationId = await encolarInvitacion(
          this.invitaciones,
          this.cola,
          invitado.id,
          requestId,
        )
        resultado.queued.push({ guestId: invitado.id, invitationId })
      } catch (error) {
        // Se registra ANTES de reportarlo: 150 ENQUEUE_FAILED por una caída de
        // Redis sin una línea de log serían invisibles, y un error de
        // programación quedaría enmascarado para siempre. guestId y requestId,
        // NUNCA el token: el token sólo vive dentro de `encolarInvitacion` y en el
        // payload, y ni Prisma (recibe el hash) ni la cola lo repiten en sus
        // errores.
        this.registro.error(
          `No se pudo encolar la invitación guestId=${invitado.id} requestId=${requestId}`,
          error instanceof Error ? error.stack : String(error),
        )
        resultado.skipped.push({ guestId: invitado.id, reason: 'ENQUEUE_FAILED' })
      }
    }

    return resultado
  }
}

/**
 * Crear la invitación y encolar el job van juntos, y por eso viven en una
 * función compartida con el envío individual: si divergieran, uno de los dos
 * caminos acabaría guardando el token en claro o encolando con otro jobId.
 *
 * DÓNDE VIVE EL TOKEN EN CLARO. La tabla guarda sólo el hash, así que el token
 * original no es recuperable — y el worker lo necesita para construir el
 * enlace. Por eso viaja en el PAYLOAD del job: es la única copia. Vive en Redis
 * mientras el job está pendiente o reintentando y se borra al COMPLETAR
 * (`removeOnComplete: true`, no las 24 h de la política común). Si el job
 * agota los reintentos, su payload PUEDE quedarse en Redis sin límite: el
 * recorte por `RETENCION_FALLIDOS_MS` sólo corre cuando otro job de la cola
 * falla después. Por eso el worker caduca la invitación en el último intento
 * fallido (ruling C18): el token sobrevive en Redis, pero ya no abre nada.
 * Descartadas:
 *  - guardarlo en claro en la tabla: anula el propósito del hash,
 *  - que lo genere el worker: cambiaría en cada reintento e invalidaría el
 *    enlace que el invitado ya tiene en la bandeja.
 */
export async function encolarInvitacion(
  invitaciones: InvitationRepository,
  cola: QueuePort,
  guestId: string,
  requestId: string,
): Promise<string> {
  const { token, hash } = generarTokenInvitacion()

  const invitacion = await invitaciones.crear({
    guestId,
    tokenHash: hash,
    expiresAt: caducidadInvitacion(),
  })

  const payload: PayloadInvitacion = { invitationId: invitacion.id, token, requestId }
  await cola.enqueue(COLA_INVITACIONES, JOB_INVITACION, payload, {
    jobId: jobIdDeInvitacion(invitacion.id),
    removeOnComplete: true,
    removeOnFailAfterMs: RETENCION_FALLIDOS_MS,
  })

  return invitacion.id
}

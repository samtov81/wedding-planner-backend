import { Inject, Injectable } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'

import { caducidadInvitacion, generarTokenInvitacion } from '../domain/invitation'
import { GUEST_REPOSITORY, type GuestRepository } from './guest.repository'
import { INVITATION_REPOSITORY, type InvitationRepository } from './invitation.repository'

export type MotivoOmision = 'NO_EMAIL' | 'ALREADY_RESPONDED'

export interface ResultadoEnvio {
  queued: Array<{ guestId: string; invitationId: string }>
  skipped: Array<{ guestId: string; reason: MotivoOmision }>
}

export const COLA_EMAIL = 'email' as const
export const JOB_INVITACION = 'guest-invitation'

/** Payload del job. Lo consumen el worker (aquí) y el RSVP público (Tarea 14). */
export interface PayloadInvitacion {
  invitationId: string
  token: string
  requestId: string
}

/** Un jobId determinista por invitación: encolar dos veces deja UN job. */
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

      const invitationId = await encolarInvitacion(
        this.invitaciones,
        this.cola,
        invitado.id,
        requestId,
      )
      resultado.queued.push({ guestId: invitado.id, invitationId })
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
 * enlace. Por eso viaja en el PAYLOAD del job: es la única copia, vive en Redis
 * mientras dura el job y desaparece al completarse. Descartadas:
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
  await cola.enqueue(COLA_EMAIL, JOB_INVITACION, payload, {
    jobId: jobIdDeInvitacion(invitacion.id),
  })

  return invitacion.id
}

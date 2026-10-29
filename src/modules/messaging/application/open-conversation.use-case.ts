import { Inject, Injectable } from '@nestjs/common'

import { parPermitido } from '../domain/conversacion'
import {
  ConversacionNoEncontradaError,
  ParNoPermitidoError,
  SinAccesoAlEventoError,
} from '../domain/messaging-errors'
import {
  CONVERSATION_REPOSITORY,
  type ConversacionVista,
  type ConversationRepository,
} from './conversation.repository'

/**
 * Abre (o recupera) la conversación entre quien pide y otra persona del evento.
 *
 * Orden de las comprobaciones, pensado para no filtrar de más: primero que YO
 * tenga acceso hoy (403), luego que no sea conmigo mismo ni proveedor con
 * proveedor (403), y por último que el OTRO lo tenga (404, igual que un id que
 * no existe: no confirma quién está en el evento). `creada` deja que REST
 * conteste 201 o 200; la carrera de dos aperturas simultáneas la resuelve el
 * repositorio, no este caso de uso.
 */
@Injectable()
export class OpenConversationUseCase {
  constructor(@Inject(CONVERSATION_REPOSITORY) private readonly repo: ConversationRepository) {}

  async ejecutar(
    yo: string,
    eventId: string,
    otroId: string,
  ): Promise<{ conversacion: ConversacionVista; creada: boolean }> {
    const miRol = await this.repo.rolEnEvento(eventId, yo)
    if (miRol === null) throw new SinAccesoAlEventoError()
    if (otroId === yo) throw new ParNoPermitidoError()

    const suRol = await this.repo.rolEnEvento(eventId, otroId)
    if (suRol === null) throw new ConversacionNoEncontradaError()
    if (!parPermitido(miRol, suRol)) throw new ParNoPermitidoError()

    const { id, creada } = await this.repo.abrir(eventId, yo, otroId)
    const conversacion = await this.repo.buscar(id, yo)
    // Acaba de crearse con acceso de ambos: que no aparezca es un fallo, no un 404.
    if (conversacion === null) throw new ConversacionNoEncontradaError()
    return { conversacion, creada }
  }
}

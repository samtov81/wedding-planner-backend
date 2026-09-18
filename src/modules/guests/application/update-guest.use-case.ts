import { Inject, Injectable } from '@nestjs/common'

import {
  UNIDAD_DE_TRABAJO,
  type UnidadDeTrabajo,
} from '@/modules/database/application/unidad-de-trabajo'

import type { Guest } from '../domain/guest'
import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import { GUEST_REPOSITORY, type CambiosInvitado, type GuestRepository } from './guest.repository'
import { INVITATION_REPOSITORY, type InvitationRepository } from './invitation.repository'

@Injectable()
export class UpdateGuestUseCase {
  constructor(
    @Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository,
    @Inject(INVITATION_REPOSITORY) private readonly invitaciones: InvitationRepository,
    @Inject(UNIDAD_DE_TRABAJO) private readonly unidadDeTrabajo: UnidadDeTrabajo,
  ) {}

  async ejecutar(eventId: string, guestId: string, cambios: CambiosInvitado): Promise<Guest> {
    // Existencia comprobada ANTES de escribir: un `updateMany` filtrado por
    // (id, eventId) sobre una fila ajena afectaría a cero filas y respondería
    // 200 sin haber cambiado nada — un éxito que no lo es.
    const existente = await this.invitados.buscar(eventId, guestId)
    if (existente === null) throw new InvitadoNoEncontradoError()

    // Ruling C24: un cambio de email (corregir uno mal tecleado, o borrarlo)
    // caduca los enlaces que ya salieron hacia la dirección vieja. Cambio y
    // caducidad en UNA transacción: si una de las dos no se confirma, la otra
    // tampoco, y no queda un email nuevo con el enlace viejo aún vivo.
    const cambiaEmail = cambios.email !== undefined && cambios.email !== existente.email
    if (!cambiaEmail) return await this.invitados.actualizar(eventId, guestId, cambios)

    return await this.unidadDeTrabajo.ejecutar(async () => {
      const actualizado = await this.invitados.actualizar(eventId, guestId, cambios)
      await this.invitaciones.caducarVigentesDe(guestId, new Date())
      return actualizado
    })
  }
}

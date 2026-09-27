import { Inject, Injectable } from '@nestjs/common'

import type { CursorPage, CursorValue } from '@/shared/domain'

import type { Guest } from '../domain/guest'
import { GUEST_REPOSITORY, type GuestFilters, type GuestRepository } from './guest.repository'

@Injectable()
export class ListGuestsUseCase {
  constructor(@Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository) {}

  async ejecutar(
    eventId: string,
    filtros: GuestFilters,
    cursor: CursorValue | null,
    limite: number,
  ): Promise<CursorPage<Guest>> {
    return await this.invitados.listar(eventId, filtros, cursor, limite)
  }
}

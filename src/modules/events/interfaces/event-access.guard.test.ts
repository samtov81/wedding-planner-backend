import 'reflect-metadata'

import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/shared/domain'

import { EventAccessService } from '../application/event-access.service'
import { EventRepositoryEnMemoria } from '../infrastructure/event.repository.fake'
import { EventAccessGuard } from './event-access.guard'
import { RequireEventAccess } from './require-event-access.decorator'

const UUID_EVENTO = '11111111-1111-4111-8111-111111111111'

/**
 * Controlador de mentira: dos rutas, una abierta y otra sólo para COUPLE.
 * Los métodos se anotan `this: void` porque el test los pasa sueltos a
 * `getHandler()`, exactamente como hace Nest, y sin la anotación
 * `@typescript-eslint/unbound-method` los da por mal desligados.
 */
class ControladorDePrueba {
  cualquiera(this: void): void {}

  @RequireEventAccess('COUPLE')
  soloPareja(this: void): void {}
}

interface PeticionFalsa {
  params: Record<string, string | undefined>
  user?: { id: string; systemRole: 'USER' | 'ADMIN' }
  eventAccess?: unknown
}

function contextoCon(req: PeticionFalsa, handler: () => void): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => ControladorDePrueba,
  } as unknown as ExecutionContext
}

describe('EventAccessGuard', () => {
  let repo: EventRepositoryEnMemoria
  let guard: EventAccessGuard
  const abierta = ControladorDePrueba.prototype.cualquiera
  const soloPareja = ControladorDePrueba.prototype.soloPareja

  beforeEach(() => {
    repo = new EventRepositoryEnMemoria()
    repo.eventos.push({ id: UUID_EVENTO, ownerId: 'ana' })
    repo.membresias.push({
      eventId: UUID_EVENTO,
      userId: 'ana',
      role: 'COUPLE',
      status: 'ACTIVE',
    })
    repo.membresias.push({
      eventId: UUID_EVENTO,
      userId: 'pedro',
      role: 'PLANNER',
      status: 'ACTIVE',
    })
    guard = new EventAccessGuard(new EventAccessService(repo), new Reflector())
  })

  it('deja pasar a un miembro activo y deja el acceso resuelto en la petición', async () => {
    const req: PeticionFalsa = {
      params: { eventId: UUID_EVENTO },
      user: { id: 'ana', systemRole: 'USER' },
    }

    await expect(guard.canActivate(contextoCon(req, abierta))).resolves.toBe(true)
    expect(req.eventAccess).toEqual({ kind: 'member', role: 'COUPLE' })
  })

  it('responde 404 y NO 403 a quien no tiene ningún acceso al evento', async () => {
    const req: PeticionFalsa = {
      params: { eventId: UUID_EVENTO },
      user: { id: 'extraño', systemRole: 'USER' },
    }

    await expect(guard.canActivate(contextoCon(req, abierta))).rejects.toBeInstanceOf(NotFoundError)
  })

  it('da el MISMO error para un evento ajeno que para uno inexistente', async () => {
    const ajeno: PeticionFalsa = {
      params: { eventId: UUID_EVENTO },
      user: { id: 'extraño', systemRole: 'USER' },
    }
    const inexistente: PeticionFalsa = {
      params: { eventId: '00000000-0000-4000-8000-000000000000' },
      user: { id: 'extraño', systemRole: 'USER' },
    }

    const errorAjeno = await guard.canActivate(contextoCon(ajeno, abierta)).catch((e: unknown) => e)
    const errorInexistente = await guard
      .canActivate(contextoCon(inexistente, abierta))
      .catch((e: unknown) => e)

    expect(errorAjeno).toBeInstanceOf(NotFoundError)
    expect(errorInexistente).toBeInstanceOf(NotFoundError)
    expect((errorAjeno as NotFoundError).code).toBe((errorInexistente as NotFoundError).code)
    expect((errorAjeno as NotFoundError).message).toBe((errorInexistente as NotFoundError).message)
  })

  it('un eventId que ni siquiera es un UUID también es 404, no un 500', async () => {
    const req: PeticionFalsa = {
      params: { eventId: 'no-es-un-uuid' },
      user: { id: 'ana', systemRole: 'USER' },
    }

    await expect(guard.canActivate(contextoCon(req, abierta))).rejects.toBeInstanceOf(NotFoundError)
  })

  it('responde 403 a quien SÍ tiene acceso pero no el rol que la ruta exige', async () => {
    const req: PeticionFalsa = {
      params: { eventId: UUID_EVENTO },
      user: { id: 'pedro', systemRole: 'USER' },
    }

    await expect(guard.canActivate(contextoCon(req, soloPareja))).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('el rol exigido sí deja pasar', async () => {
    const req: PeticionFalsa = {
      params: { eventId: UUID_EVENTO },
      user: { id: 'ana', systemRole: 'USER' },
    }

    await expect(guard.canActivate(contextoCon(req, soloPareja))).resolves.toBe(true)
  })

  it('un ADMIN se salta la lista de roles permitidos', async () => {
    const req: PeticionFalsa = {
      params: { eventId: UUID_EVENTO },
      user: { id: 'root', systemRole: 'ADMIN' },
    }

    await expect(guard.canActivate(contextoCon(req, soloPareja))).resolves.toBe(true)
    expect(req.eventAccess).toEqual({ kind: 'admin' })
  })

  it('un vendor BOOKED cuenta como VENDOR frente a la lista de permitidos', async () => {
    repo.perfiles.push({ id: 'perfil-1', userId: 'foto' })
    repo.eventVendors.push({
      id: 'ev-v-1',
      eventId: UUID_EVENTO,
      vendorProfileId: 'perfil-1',
      status: 'BOOKED',
    })
    const req: PeticionFalsa = {
      params: { eventId: UUID_EVENTO },
      user: { id: 'foto', systemRole: 'USER' },
    }

    await expect(guard.canActivate(contextoCon(req, abierta))).resolves.toBe(true)
    expect(req.eventAccess).toEqual({ kind: 'vendor', eventVendorId: 'ev-v-1' })
    await expect(guard.canActivate(contextoCon(req, soloPareja))).rejects.toBeInstanceOf(
      ForbiddenError,
    )
  })

  it('sin usuario autenticado es 401: falta identidad, no permiso', async () => {
    const req: PeticionFalsa = { params: { eventId: UUID_EVENTO } }

    await expect(guard.canActivate(contextoCon(req, abierta))).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
  })
})

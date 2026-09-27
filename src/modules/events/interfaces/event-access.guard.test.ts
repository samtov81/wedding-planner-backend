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
 * Controlador de mentira: una ruta abierta a todo acceso, otra sólo para
 * COUPLE y otra a la que se le OLVIDÓ el decorador. Los métodos se anotan
 * `this: void` porque el test los pasa sueltos a `getHandler()`, exactamente
 * como hace Nest, y sin la anotación `@typescript-eslint/unbound-method` los
 * da por mal desligados.
 */
class ControladorDePrueba {
  @RequireEventAccess('COUPLE', 'PLANNER', 'VENDOR')
  cualquiera(this: void): void {}

  @RequireEventAccess('COUPLE')
  soloPareja(this: void): void {}

  sinDecorador(this: void): void {}
}

/** El decorador en la CLASE, como lo escribió el primer borrador de la Tarea 10. */
@RequireEventAccess('COUPLE')
class ControladorSoloParejaEnClase {
  heredaLaClase(this: void): void {}

  @RequireEventAccess('COUPLE', 'PLANNER')
  elMetodoGana(this: void): void {}
}

interface PeticionFalsa {
  params: Record<string, string | undefined>
  user?: { id: string; systemRole: 'USER' | 'ADMIN' }
  eventAccess?: unknown
}

function contextoCon(
  req: PeticionFalsa,
  handler: () => void,
  clase: abstract new () => unknown = ControladorDePrueba,
): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => clase,
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

  describe('falla CERRADO: la lista de permitidos es obligatoria', () => {
    it.each([
      ['un miembro COUPLE', { id: 'ana', systemRole: 'USER' as const }],
      ['un ADMIN', { id: 'root', systemRole: 'ADMIN' as const }],
      ['un extraño', { id: 'extraño', systemRole: 'USER' as const }],
    ])(
      'una ruta sin @RequireEventAccess es un error de programación (500) para %s',
      async (_q, user) => {
        const req: PeticionFalsa = { params: { eventId: UUID_EVENTO }, user }
        const sinDecorador = ControladorDePrueba.prototype.sinDecorador

        const error = await guard
          .canActivate(contextoCon(req, sinDecorador))
          .catch((e: unknown) => e)

        // Un `Error` plano, no un `DomainError`: el filtro lo convierte en 500.
        expect(error).toBeInstanceOf(Error)
        expect(error).not.toBeInstanceOf(NotFoundError)
        expect(error).not.toBeInstanceOf(ForbiddenError)
        expect((error as Error).message).toBe('EventAccessGuard requires @RequireEventAccess')
        expect(req.eventAccess).toBeUndefined()
      },
    )
  })

  describe('la metadata de CLASE cuenta (el bypass del primer borrador de la Tarea 10)', () => {
    const heredaLaClase = ControladorSoloParejaEnClase.prototype.heredaLaClase
    const elMetodoGana = ControladorSoloParejaEnClase.prototype.elMetodoGana

    it('un decorador en la clase se aplica a sus métodos: un PLANNER recibe 403', async () => {
      const pedro: PeticionFalsa = {
        params: { eventId: UUID_EVENTO },
        user: { id: 'pedro', systemRole: 'USER' },
      }
      const ana: PeticionFalsa = {
        params: { eventId: UUID_EVENTO },
        user: { id: 'ana', systemRole: 'USER' },
      }

      await expect(
        guard.canActivate(contextoCon(pedro, heredaLaClase, ControladorSoloParejaEnClase)),
      ).rejects.toBeInstanceOf(ForbiddenError)
      await expect(
        guard.canActivate(contextoCon(ana, heredaLaClase, ControladorSoloParejaEnClase)),
      ).resolves.toBe(true)
    })

    it('un vendor BOOKED tampoco pasa por una ruta restringida en la clase', async () => {
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

      await expect(
        guard.canActivate(contextoCon(req, heredaLaClase, ControladorSoloParejaEnClase)),
      ).rejects.toBeInstanceOf(ForbiddenError)
    })

    it('el decorador del método, si lo hay, prevalece sobre el de la clase', async () => {
      const pedro: PeticionFalsa = {
        params: { eventId: UUID_EVENTO },
        user: { id: 'pedro', systemRole: 'USER' },
      }

      await expect(
        guard.canActivate(contextoCon(pedro, elMetodoGana, ControladorSoloParejaEnClase)),
      ).resolves.toBe(true)
    })
  })

  it('sin usuario autenticado es 401: falta identidad, no permiso', async () => {
    const req: PeticionFalsa = { params: { eventId: UUID_EVENTO } }

    await expect(guard.canActivate(contextoCon(req, abierta))).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
  })
})

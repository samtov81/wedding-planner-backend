import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ThrottlerException, type ThrottlerStorage } from '@nestjs/throttler'

type Registro = Awaited<ReturnType<ThrottlerStorage['increment']>>

import { UnauthorizedError } from '@/shared/domain'

import { LimitePorUsuario, LimitePorUsuarioGuard } from './limite-por-usuario'

/** Almacén en memoria con la misma firma que el de Redis: cuenta por clave + nombre. */
class AlmacenEnMemoria implements ThrottlerStorage {
  readonly claves: string[] = []
  private readonly golpes = new Map<string, number>()

  increment(
    key: string,
    ttl: number,
    limit: number,
    _bloqueo: number,
    nombre: string,
  ): Promise<Registro> {
    const clave = `${key}:${nombre}`
    this.claves.push(clave)
    const totalHits = (this.golpes.get(clave) ?? 0) + 1
    this.golpes.set(clave, totalHits)
    return Promise.resolve({
      totalHits,
      timeToExpire: ttl,
      isBlocked: totalHits > limit,
      timeToBlockExpire: 0,
    })
  }
}

class Ruta {
  @LimitePorUsuario('prueba', { limit: 10, ttl: 3_600_000 })
  manejar(this: void): void {}
}

function contexto(user: { id: string } | undefined): ExecutionContext {
  return {
    getHandler: () => Ruta.prototype.manejar,
    getClass: () => Ruta,
    switchToHttp: () => ({ getRequest: () => (user === undefined ? {} : { user }) }),
  } as unknown as ExecutionContext
}

describe('LimitePorUsuarioGuard', () => {
  it('deja pasar 10 peticiones y la 11.ª lanza ThrottlerException', async () => {
    const guard = new LimitePorUsuarioGuard(new AlmacenEnMemoria(), new Reflector())
    for (let i = 0; i < 10; i++) {
      await expect(guard.canActivate(contexto({ id: 'u1' }))).resolves.toBe(true)
    }
    await expect(guard.canActivate(contexto({ id: 'u1' }))).rejects.toBeInstanceOf(
      ThrottlerException,
    )
  })

  it('dos usuarios no comparten cupo', async () => {
    const guard = new LimitePorUsuarioGuard(new AlmacenEnMemoria(), new Reflector())
    for (let i = 0; i < 10; i++) await guard.canActivate(contexto({ id: 'u1' }))
    await expect(guard.canActivate(contexto({ id: 'u2' }))).resolves.toBe(true)
  })

  it('cuenta por usuario y por nombre de límite', async () => {
    const almacen = new AlmacenEnMemoria()
    await new LimitePorUsuarioGuard(almacen, new Reflector()).canActivate(contexto({ id: 'u1' }))
    expect(almacen.claves).toEqual(['usuario:u1:prueba'])
  })

  it('sin req.user falla cerrado con UnauthorizedError', async () => {
    const guard = new LimitePorUsuarioGuard(new AlmacenEnMemoria(), new Reflector())
    await expect(guard.canActivate(contexto(undefined))).rejects.toBeInstanceOf(UnauthorizedError)
  })
})

import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { ThrottlerException, type ThrottlerStorage } from '@nestjs/throttler'

import { DomainError, UnauthorizedError } from '@/shared/domain'

import { LimitePorUsuario, LimitePorUsuarioGuard } from './limite-por-usuario'

type Registro = Awaited<ReturnType<ThrottlerStorage['increment']>>

/** Almacén en memoria con la misma firma que el de Redis: cuenta por clave + nombre. */
class AlmacenEnMemoria implements ThrottlerStorage {
  readonly claves: string[] = []
  private readonly golpes = new Map<string, number>()

  increment(
    key: string,
    ttl: number,
    limit: number,
    bloqueo: number,
    nombre: string,
  ): Promise<Registro> {
    const clave = `${key}:${nombre}`
    this.claves.push(clave)
    const totalHits = (this.golpes.get(clave) ?? 0) + 1
    this.golpes.set(clave, totalHits)
    // En segundos, como `ThrottlerStorageRedisService`; el bloqueo dura `bloqueo` ms.
    const isBlocked = totalHits > limit
    return Promise.resolve({
      totalHits,
      timeToExpire: Math.ceil(ttl / 1000),
      isBlocked,
      timeToBlockExpire: isBlocked ? Math.ceil(bloqueo / 1000) : 0,
    })
  }
}

class Ruta {
  @LimitePorUsuario('prueba', { limit: 10, ttl: 3_600_000 })
  manejar(this: void): void {}

  /** El guard puesto a mano, sin `@LimitePorUsuario`: un error de cableado. */
  sinLimite(this: void): void {}

  @LimitePorUsuario('por-evento', { limit: 2, ttl: 3_600_000, porParametro: 'eventId' })
  porEvento(this: void): void {}
}

/** Las cabeceras que el guard pone en la respuesta, como `res.header` de Express. */
type Cabeceras = Map<string, string | number>

function contexto(
  user: { id: string } | undefined,
  cabeceras: Cabeceras = new Map(),
  manejador: (this: void) => void = Ruta.prototype.manejar,
  params: Record<string, string> = {},
): ExecutionContext {
  return {
    getHandler: () => manejador,
    getClass: () => Ruta,
    switchToHttp: () => ({
      getRequest: () => (user === undefined ? { params } : { user, params }),
      getResponse: () => ({
        header: (nombre: string, valor: string | number) => cabeceras.set(nombre, valor),
      }),
    }),
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

  it('la 429 lleva Retry-After en segundos, con y sin el sufijo del límite (como ThrottlerGuard)', async () => {
    const guard = new LimitePorUsuarioGuard(new AlmacenEnMemoria(), new Reflector())
    for (let i = 0; i < 10; i++) await guard.canActivate(contexto({ id: 'u1' }))
    const cabeceras: Cabeceras = new Map()
    await expect(guard.canActivate(contexto({ id: 'u1' }, cabeceras))).rejects.toBeInstanceOf(
      ThrottlerException,
    )
    expect(Object.fromEntries(cabeceras)).toEqual({
      'Retry-After': 3600,
      'Retry-After-prueba': 3600,
    })
  })

  it('mientras no corta no pone Retry-After', async () => {
    const guard = new LimitePorUsuarioGuard(new AlmacenEnMemoria(), new Reflector())
    const cabeceras: Cabeceras = new Map()
    await guard.canActivate(contexto({ id: 'u1' }, cabeceras))
    expect(cabeceras.size).toBe(0)
  })

  it('sin @LimitePorUsuario falla cerrado con un error de programación (no deja pasar)', async () => {
    const almacen = new AlmacenEnMemoria()
    const guard = new LimitePorUsuarioGuard(almacen, new Reflector())
    const intento = guard.canActivate(contexto({ id: 'u1' }, new Map(), Ruta.prototype.sinLimite))
    await expect(intento).rejects.toThrow(/@LimitePorUsuario/)
    await expect(intento).rejects.not.toBeInstanceOf(DomainError)
    expect(almacen.claves).toEqual([])
  })

  describe('con porParametro', () => {
    const enEvento = (userId: string, eventId: string) =>
      contexto({ id: userId }, new Map(), Ruta.prototype.porEvento, { eventId })

    it('cuenta por usuario Y por el valor del parámetro', async () => {
      const almacen = new AlmacenEnMemoria()
      await new LimitePorUsuarioGuard(almacen, new Reflector()).canActivate(enEvento('u1', 'e1'))
      expect(almacen.claves).toEqual(['usuario:u1:eventId:e1:por-evento'])
    })

    it('agotar el cupo en un evento no corta en otro, ni a otro usuario en el mismo', async () => {
      const guard = new LimitePorUsuarioGuard(new AlmacenEnMemoria(), new Reflector())
      for (let i = 0; i < 2; i++) await guard.canActivate(enEvento('u1', 'e1'))
      await expect(guard.canActivate(enEvento('u1', 'e1'))).rejects.toBeInstanceOf(
        ThrottlerException,
      )
      await expect(guard.canActivate(enEvento('u1', 'e2'))).resolves.toBe(true)
      await expect(guard.canActivate(enEvento('u2', 'e1'))).resolves.toBe(true)
    })

    it('si la ruta no trae el parámetro falla cerrado con un error de programación', async () => {
      const almacen = new AlmacenEnMemoria()
      const guard = new LimitePorUsuarioGuard(almacen, new Reflector())
      const intento = guard.canActivate(contexto({ id: 'u1' }, new Map(), Ruta.prototype.porEvento))
      await expect(intento).rejects.toThrow(/eventId/)
      await expect(intento).rejects.not.toBeInstanceOf(DomainError)
      expect(almacen.claves).toEqual([])
    })
  })
})

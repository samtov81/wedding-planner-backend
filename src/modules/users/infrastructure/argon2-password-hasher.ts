import { Injectable } from '@nestjs/common'
import argon2 from 'argon2'

import type { PasswordHasher } from '../application/password-hasher.port'

/**
 * Argon2id, no bcrypt. Argon2 ganó el Password Hashing Competition y su coste
 * es en memoria además de en CPU, lo que le quita a un atacante con GPU o ASIC
 * la ventaja que sí tiene contra bcrypt. Y bcrypt sigue truncando a 72 bytes.
 *
 * Parámetros: los recomendados por OWASP para argon2id (19 MiB, 2 iteraciones,
 * paralelismo 1). Subirlos protege más pero encarece cada login: si se tocan,
 * hay que medir la latencia del login, no estimarla.
 */
@Injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly opciones = {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  } as const

  hash(plano: string): Promise<string> {
    return argon2.hash(plano, this.opciones)
  }

  async verify(hash: string, plano: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plano)
    } catch {
      // Un hash corrupto en la tabla no puede producir un 500: la diferencia
      // entre 500 y 401 le dice al atacante que ese usuario existe y es raro.
      return false
    }
  }
}

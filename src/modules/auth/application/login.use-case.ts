import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'

import {
  PASSWORD_HASHER,
  type PasswordHasher,
} from '@/modules/users/application/password-hasher.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import { CredencialesInvalidasError } from '../domain/auth-errors'
import { SESSION_REPOSITORY, type SessionRepository } from './session.repository'
import { TokenService } from './token.service'

/**
 * Hash Argon2id de una contraseña señuelo, fijo en el código (nunca se
 * calcula en runtime). Cuando el email no existe, `verify` se llama contra
 * ESTE hash antes de responder: así el coste de CPU/memoria de Argon2 se paga
 * siempre, exista o no la cuenta. Sin esto, un login a un email inexistente
 * responde en ~2ms y uno real en ~60ms, y esa diferencia sola enumera cuentas.
 */
const HASH_SENUELO =
  '$argon2id$v=19$m=19456,p=1,t=2$j7pNw5koWTLAeSPZ5gl3iA$HN3NsSA6hYYLwSGQQtc8e0n9qEKmz6aAOVsjBlFSq3I'

export interface DatosLogin {
  email: string
  password: string
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(SESSION_REPOSITORY) private readonly sesiones: SessionRepository,
    private readonly tokens: TokenService,
  ) {}

  async ejecutar(datos: DatosLogin): Promise<{ accessToken: string; refreshToken: string }> {
    const usuario = await this.usuarios.findByEmail(datos.email)

    // Se verifica SIEMPRE, exista o no el usuario, y contra el mismo tipo de
    // hash (Argon2id): eso es lo que igualo el tiempo de respuesta.
    const hashAComprobar = usuario?.passwordHash ?? HASH_SENUELO
    const claveValida = await this.hasher.verify(hashAComprobar, datos.password)

    // Mismo error, mismo código, para "no existe" y para "contraseña mal":
    // distinguirlos es lo que permite enumerar cuentas.
    if (usuario === null || !claveValida) throw new CredencialesInvalidasError()

    const familyId = randomUUID()
    const refresh = this.tokens.generarRefresh()
    await this.sesiones.crear({
      userId: usuario.id,
      tokenHash: refresh.hash,
      familyId,
      expiresAt: this.tokens.caducidadRefresh(),
    })

    return {
      accessToken: this.tokens.firmarAccess({ id: usuario.id, systemRole: usuario.systemRole }),
      refreshToken: refresh.token,
    }
  }
}

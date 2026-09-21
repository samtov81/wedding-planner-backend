import { randomBytes } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'

import { QUEUE_PORT, type QueuePort } from '@/modules/queue/application/queue.port'
import {
  PASSWORD_HASHER,
  type PasswordHasher,
} from '@/modules/users/application/password-hasher.port'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import type { User } from '@/modules/users/domain/user'

export interface DatosRegistro {
  email: string
  password: string
  fullName: string
}

@Injectable()
export class RegisterUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(QUEUE_PORT) private readonly cola: QueuePort,
  ) {}

  async ejecutar(datos: DatosRegistro): Promise<User> {
    const passwordHash = await this.hasher.hash(datos.password)
    const usuario = await this.usuarios.create({
      email: datos.email,
      passwordHash,
      fullName: datos.fullName,
    })

    // DESIGN-GAP: no existe tabla para persistir tokens de verificación de
    // email (el esquema de la Tarea 8 no la trae y no se toca aquí). El token
    // viaja sólo dentro del job encolado; consumirlo con un endpoint
    // `POST /auth/verify-email` queda para cuando exista dónde guardarlo.
    const tokenVerificacion = randomBytes(32).toString('hex')

    // Encolado, NUNCA en línea: un correo que tarda o falla no puede bloquear
    // ni fallar la respuesta del registro. jobId determinista = idempotente:
    // reintentar la petición no duplica el correo.
    // Separador `-`, no `:`: BullMQ usa `:` como separador de claves en Redis
    // y rechaza un customId que lo contenga ("Custom Id cannot contain :"),
    // así que el `verify-email:<userId>` literal de la especificación no
    // llega a encolarse nunca (lanza en `Queue.add`, antes de tocar Redis).
    await this.cola.enqueue(
      'email',
      'verify-email',
      { userId: usuario.id, email: usuario.email, token: tokenVerificacion },
      { jobId: `verify-email-${usuario.id}` },
    )

    return usuario
  }
}

import { Inject, Injectable } from '@nestjs/common'
import { hashToken } from './token.service'
import {
  EMAIL_VERIFICATION_TOKEN_REPOSITORY,
  type EmailVerificationTokenRepository,
} from './email-verification-token.repository'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

export type OutcomeVerificacion = 'verified' | 'already_verified' | 'invalid_or_expired'

export interface ResultadoVerificacion {
  outcome: OutcomeVerificacion
}

@Injectable()
export class VerifyEmailUseCase {
  constructor(
    @Inject(EMAIL_VERIFICATION_TOKEN_REPOSITORY)
    private readonly tokens: EmailVerificationTokenRepository,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
  ) {}

  async ejecutar(tokenEnClaro: string): Promise<ResultadoVerificacion> {
    const hash = hashToken(tokenEnClaro)
    const resultado = await this.tokens.consumirPorHash(hash, new Date())

    if (resultado.resultado === 'CONSUMIDO' && resultado.userId) {
      // Marcar el email como verificado y devolver éxito
      await this.usuarios.marcarEmailVerificado(resultado.userId)
      return { outcome: 'verified' }
    }

    if (resultado.resultado === 'YA_CONSUMIDO') {
      return { outcome: 'already_verified' }
    }

    // NO_ENCONTRADO_O_CADUCADO
    return { outcome: 'invalid_or_expired' }
  }
}

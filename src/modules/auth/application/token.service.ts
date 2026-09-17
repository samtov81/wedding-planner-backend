import { createHash, randomBytes } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import jwt from 'jsonwebtoken'

import { ENV } from '@/config/config.module'

/** SHA-256 basta: el token ya es aleatorio de 32 bytes, no hay nada que forzar. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

interface ConfigTokens {
  JWT_ACCESS_SECRET: string
  JWT_ACCESS_TTL: string
  REFRESH_TTL_DAYS: number
}

@Injectable()
export class TokenService {
  constructor(@Inject(ENV) private readonly env: ConfigTokens) {}

  firmarAccess(user: { id: string; systemRole: string }): string {
    return jwt.sign({ sub: user.id, role: user.systemRole }, this.env.JWT_ACCESS_SECRET, {
      expiresIn: this.env.JWT_ACCESS_TTL,
    } as jwt.SignOptions)
  }

  verificarAccess(token: string): { sub: string; role: string } {
    const payload = jwt.verify(token, this.env.JWT_ACCESS_SECRET)
    if (typeof payload === 'string' || typeof payload.sub !== 'string') {
      throw new Error('Payload de access token inválido')
    }
    return { sub: payload.sub, role: String(payload.role) }
  }

  /**
   * Refresh OPACO, no un JWT: no lleva claims, no se puede inspeccionar y se
   * revoca borrando una fila. Un JWT de refresh es irrevocable por diseño.
   * Se devuelve el token en claro (va al cliente) y su hash (va a la tabla):
   * la base de datos nunca guarda el token.
   */
  generarRefresh(): { token: string; hash: string } {
    const token = randomBytes(32).toString('base64url')
    return { token, hash: hashToken(token) }
  }

  caducidadRefresh(): Date {
    return new Date(Date.now() + this.env.REFRESH_TTL_DAYS * 86_400_000)
  }
}

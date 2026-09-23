import { Inject, Injectable } from '@nestjs/common'

import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'

import { RefreshInvalidoError, RefreshReutilizadoError } from '../domain/token-errors'
import { SESSION_REPOSITORY, type SesionPersistida, type SessionRepository } from './session.repository'
import { hashToken, TokenService } from './token.service'

/**
 * Ventana de gracia para el reuso de un refresh recién rotado, en milisegundos.
 *
 * Existe por un caso real, no hipotético: dos pestañas (o dos documentos que
 * comparten la misma cookie `httpOnly` de refresh, por ejemplo tras restaurar
 * la sesión del navegador) arrancan a la vez y las dos llaman a `/auth/refresh`
 * con el MISMO token, antes de que ninguna de las dos haya visto la respuesta
 * de la otra. Sin ventana, la perdedora del compare-and-swap de `rotar` —o
 * quien presenta el token justo después de que la ganadora ya lo rotó— se
 * trata como un ladrón y cae la familia entera: las dos pestañas acaban en la
 * pantalla de login sin haber hecho nada raro.
 *
 * Diez segundos cubre ese escenario (dos peticiones disparadas en el mismo
 * evento de arranque, incluso con latencia de red mala) sin abrir una puerta
 * útil para un atacante real: el reuso genuino de un token robado casi nunca
 * ocurre en la misma decena de segundos que la rotación legítima, y aunque
 * ocurriera, la ventana sólo le vale de algo si TAMBIÉN sabe que la sucesora
 * sigue viva — cosa que no controla. Pasada la ventana, el comportamiento es
 * exactamente el de antes: cualquier reuso tumba la familia.
 */
const VENTANA_GRACIA_MS = 10_000

@Injectable()
export class RefreshUseCase {
  constructor(
    @Inject(SESSION_REPOSITORY) private readonly sesiones: SessionRepository,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly tokens: TokenService,
  ) {}

  async ejecutar(refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const sesion = await this.sesiones.buscarPorHash(hashToken(refreshToken))

    if (sesion === null) throw new RefreshInvalidoError()

    // Presentar un refresh YA REVOCADO tiene dos explicaciones posibles, y hay
    // que distinguirlas por tiempo: (a) el cliente legítimo ya rotó hace un
    // rato y esto es un token robado que reaparece — reuso genuino, cae la
    // familia — o (b) esto es una segunda petición concurrente del MISMO
    // cliente (dos pestañas, el mismo arranque) que llegó a leer el hash antes
    // de que la primera terminase de rotar, y ahora se encuentra la sesión ya
    // revocada por su gemela. `intentarContinuarComoConcurrente` decide cuál
    // de las dos es, mirando si la revocación fue reciente Y si la sucesora
    // sigue viva.
    if (sesion.revokedAt !== null) {
      const continuada = await this.intentarContinuarComoConcurrente(sesion)
      if (continuada !== null) return continuada

      await this.sesiones.revocarFamilia(sesion.familyId)
      throw new RefreshReutilizadoError()
    }

    if (sesion.expiresAt.getTime() <= Date.now()) throw new RefreshInvalidoError()

    const nuevo = this.tokens.generarRefresh()

    // Revocar + crear en UNA operación atómica. El booleano es el resultado
    // del compare-and-swap: `false` significa que otra petición revocó esta
    // misma sesión entre la lectura de arriba y este punto. Dos peticiones
    // con el MISMO refresh, exactamente a la vez, sólo pueden ser dos
    // documentos del mismo cliente legítimo (el atacante nunca dispara su
    // copia en el mismo instante que el dueño) — así que perder la carrera
    // entra por la misma puerta de gracia que el caso de arriba, en vez de
    // tumbar la familia sin más.
    const ganada = await this.sesiones.rotar({
      sesionARevocar: sesion.id,
      nueva: {
        userId: sesion.userId,
        tokenHash: nuevo.hash,
        familyId: sesion.familyId,
        expiresAt: this.tokens.caducidadRefresh(),
      },
    })

    if (!ganada) {
      const continuada = await this.intentarContinuarComoConcurrente(sesion)
      if (continuada !== null) return continuada

      await this.sesiones.revocarFamilia(sesion.familyId)
      throw new RefreshReutilizadoError()
    }

    return await this.firmarRespuesta(sesion.userId, nuevo.token)
  }

  /**
   * Ventana de gracia: si la sesión de la familia sigue teniendo una sucesora
   * VIVA y sin caducar, esta petición se trata como la gemela concurrente del
   * cliente legítimo. No se puede "devolver los tokens de la sucesora" en el
   * sentido literal —sólo se guarda el HASH de su refresh, nunca el token en
   * claro, así que no hay forma de reconstruirlo para dárselo a esta segunda
   * petición—, así que en su lugar se rota la sucesora UNA VEZ MÁS: la
   * petición perdedora recibe un par de tokens nuevo y válido, la familia
   * sigue viva, y la próxima vez que cualquiera de las dos pestañas refresque
   * usará ese nuevo token sin fricción.
   *
   * Devuelve `null` cuando no hay ventana de gracia aplicable (sucesora
   * inexistente, caducada, o la revocación ya es demasiado vieja): en ese
   * caso el llamante trata la petición como reuso genuino.
   */
  private async intentarContinuarComoConcurrente(
    sesion: SesionPersistida,
  ): Promise<{ accessToken: string; refreshToken: string } | null> {
    if (sesion.revokedAt !== null && Date.now() - sesion.revokedAt.getTime() > VENTANA_GRACIA_MS) {
      return null
    }

    const viva = await this.sesiones.buscarSesionVivaDeFamilia(sesion.familyId)
    if (viva === null || viva.expiresAt.getTime() <= Date.now()) return null

    const nuevo = this.tokens.generarRefresh()
    const ganada = await this.sesiones.rotar({
      sesionARevocar: viva.id,
      nueva: {
        userId: viva.userId,
        tokenHash: nuevo.hash,
        familyId: viva.familyId,
        expiresAt: this.tokens.caducidadRefresh(),
      },
    })
    // Si esta rotación TAMBIÉN pierde el CAS (una tercera petición concurrente
    // se adelantó), no se reintenta indefinidamente: se trata como reuso y que
    // la siguiente llamada, si la hay, encuentre una sucesora ya asentada.
    if (!ganada) return null

    return await this.firmarRespuesta(viva.userId, nuevo.token)
  }

  private async firmarRespuesta(
    userId: string,
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string }> {
    // El rol se relee del usuario, NO se asume: firmar siempre 'USER' degradaría
    // a un admin en cuanto refrescara, y cachearlo en la sesión dejaría vivo el
    // rol antiguo durante toda la vida del refresh tras un cambio de permisos.
    const usuario = await this.usuarios.findById(userId)
    if (usuario === null) throw new RefreshInvalidoError()

    return {
      accessToken: this.tokens.firmarAccess({ id: usuario.id, systemRole: usuario.systemRole }),
      refreshToken,
    }
  }
}

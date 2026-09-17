import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'

import { ForbiddenError, NotFoundError, UnauthorizedError } from '@/shared/domain'

import { EventAccessService } from '../application/event-access.service'
import { etiquetaDe, type PermisoDeEvento } from '../domain/event-access'
import { PERMITIDOS } from './require-event-access.decorator'

/** Mensaje ÚNICO para "aquí no hay nada para ti", exista el evento o no. */
const NO_EXISTE = 'El evento no existe'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PeticionConAcceso {
  params: Record<string, string | undefined>
  user?: { id: string; systemRole: 'USER' | 'ADMIN' }
  eventAccess?: unknown
}

@Injectable()
export class EventAccessGuard implements CanActivate {
  constructor(
    private readonly acceso: EventAccessService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(contexto: ExecutionContext): Promise<boolean> {
    const req = contexto.switchToHttp().getRequest<PeticionConAcceso>()

    // DESIGN-GAP: el brief da por hecho que `req.user` existe porque
    // `JwtAuthGuard` corre antes. Es cierto hoy, pero el orden de los guards
    // es una convención del controlador, no algo que el tipo garantice: si
    // alguien pone `EventAccessGuard` sin el de auth, leer `req.user.id`
    // reventaría con un TypeError y saldría como 500. Se comprueba y se
    // responde 401 —falta IDENTIDAD, no permiso—, que es además lo que hace
    // que el cliente reintente autenticándose en vez de rendirse.
    const usuario = req.user
    if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')

    const eventId = req.params.eventId

    // DESIGN-GAP: el brief sólo contempla el parámetro ausente. Un `:eventId`
    // que no es un UUID llegaría a Prisma y saldría como P2023 → 500, y un
    // 500 donde el resto del mundo ve 404 vuelve a ser un oráculo: distingue
    // "id con forma válida" de "id inventado". Mismo 404, mismo cuerpo.
    if (eventId === undefined || !UUID.test(eventId)) throw new NotFoundError(NO_EXISTE)

    const resultado = await this.acceso.resolve(usuario.id, usuario.systemRole, eventId)

    // 404, NO 403. Un 403 confirma que el evento existe a quien no debería
    // saberlo, y convierte cada ruta en un oráculo para enumerar la plataforma.
    if (resultado.kind === 'none') throw new NotFoundError(NO_EXISTE)

    const permitidos = this.reflector.get<PermisoDeEvento[] | undefined>(
      PERMITIDOS,
      contexto.getHandler(),
    )

    if (permitidos !== undefined && resultado.kind !== 'admin') {
      const mio = etiquetaDe(resultado)
      // Aquí SÍ 403: ya sabemos que tiene acceso al evento, así que decirle
      // que no puede hacer *esta* operación no le revela nada nuevo.
      if (mio === null || !permitidos.includes(mio)) {
        throw new ForbiddenError('No tienes permiso para esta operación en este evento')
      }
    }

    req.eventAccess = resultado
    return true
  }
}

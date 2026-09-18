import { Inject, Logger } from '@nestjs/common'
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets'
import type { Namespace, Socket } from 'socket.io'
import { z } from 'zod'

import {
  autenticarAccessToken,
  type UsuarioAutenticado,
} from '@/modules/auth/application/autenticar-access-token'
import { TokenService } from '@/modules/auth/application/token.service'
import { EventAccessService } from '@/modules/events/application/event-access.service'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import { UnauthorizedError } from '@/shared/domain'

import {
  NAMESPACE_REALTIME,
  salaDeEvento,
  salaDeUsuario,
  salaDeVendorsDeEvento,
} from '../application/salas'

/** Lo que el servidor guarda en cada socket. El token NO se registra nunca. */
interface DatosDeSocket {
  userId: string
  token: string
}

type SocketRealtime = Socket<Record<string, never>, Record<string, never>, never, DatosDeSocket>

export type RespuestaSala =
  { ok: true } | { ok: false; code: 'NOT_FOUND' | 'UNAUTHORIZED' | 'INTERNAL' }

/**
 * `z.guid()` y no `z.uuid()`: la misma forma laxa 8-4-4-4-12 que acepta
 * `EventAccessGuard`. Un id que el REST deja pasar al `EventAccessService` no
 * puede ser un "no encontrado" distinto aquí.
 */
const salaSchema = z.object({ eventId: z.guid() })

const NO_EXISTE: RespuestaSala = { ok: false, code: 'NOT_FOUND' }

/**
 * Canal de tiempo real. Autentica y autoriza con el MISMO código que el REST,
 * así que no puede existir un permiso que valga en socket y no en HTTP:
 *  - identidad: `autenticarAccessToken`, lo que ejecuta `JwtAuthGuard` (firma,
 *    rol dentro de `SystemRole` y usuario RECARGADO de la base de datos);
 *  - evento: `EventAccessService.resolve`, lo que ejecuta `EventAccessGuard`,
 *    con la misma regla de la casa: sin acceso, el evento "no existe"
 *    (`NOT_FOUND` tanto si es ajeno como si no existe o el id no es un UUID).
 *
 * DESIGN-GAP (brief, Paso 3): el brief autentica en `handleConnection` y, si
 * falla, hace `socket.emit('error', …)` + `disconnect`. Dos problemas: en
 * Socket.IO 4 `error` es un evento RESERVADO y `emit('error')` lanza, y
 * `handleConnection` corre con el socket YA conectado. Aquí la autenticación es
 * un middleware del namespace (`afterInit`): la conexión se rechaza ANTES de
 * existir y el cliente recibe `connect_error` con "No autorizado".
 *
 * DESIGN-GAP: el brief sólo verifica el token al conectar. Un socket vive
 * horas y el access token 15 minutos; si sólo se comprobara al conectar, un
 * usuario borrado seguiría entrando en salas. Cada `join` vuelve a pasar el
 * token guardado por `autenticarAccessToken`, igual que cada petición REST:
 * token caducado o usuario borrado → `UNAUTHORIZED`, y el cliente reconecta
 * con un token nuevo.
 *
 * Hueco conocido y aceptado: quien YA está en una sala sigue en ella hasta que
 * desconecta, aunque entretanto le revoquen la membresía. Echarlo exigiría que
 * la revocación publicara un evento que hoy no existe (no hay endpoint de
 * revocar). Lo que pierde es LATENCIA sobre datos que ya no puede pedir por
 * REST, no acceso a datos nuevos: el REST le responde 404 desde ese momento.
 *
 * Audiencias (ver `salas.ts`): COUPLE, PLANNER y ADMIN entran en
 * `event:<id>`; un vendor BOOKED en `event:<id>:vendors`, donde hoy no se
 * emite nada — por REST no ve invitados, y todo lo que se emite a un evento
 * son datos de invitados.
 *
 * CORS: lo pone `RedisIoAdapter` con la allowlist del entorno, la misma que el
 * HTTP. Aquí no: el CORS de Socket.IO es del servidor, no de un namespace, y el
 * decorador sólo admite valores fijos.
 */
@WebSocketGateway({ namespace: NAMESPACE_REALTIME })
export class NotificationsGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer() readonly server!: Namespace

  private readonly registro = new Logger(NotificationsGateway.name)

  constructor(
    private readonly tokens: TokenService,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly accesoAEventos: EventAccessService,
  ) {}

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      this.autenticar(socket as SocketRealtime).then(
        () => next(),
        (error: unknown) => {
          if (!(error instanceof UnauthorizedError)) {
            this.registro.error(
              'Fallo al autenticar un socket',
              error instanceof Error ? error.stack : String(error),
            )
          }
          next(Object.assign(new Error('No autorizado'), { data: { code: 'UNAUTHORIZED' } }))
        },
      )
    })
  }

  async handleConnection(socket: SocketRealtime): Promise<void> {
    await socket.join(salaDeUsuario(socket.data.userId))
  }

  @SubscribeMessage('join')
  async unirse(
    @ConnectedSocket() socket: SocketRealtime,
    @MessageBody() datos: unknown,
  ): Promise<RespuestaSala> {
    return await this.conSalaAutorizada(socket, datos, async (eventId, usuario) => {
      const acceso = await this.accesoAEventos.resolve(usuario.id, usuario.systemRole, eventId)
      // Mismo criterio que `EventAccessGuard`: sin acceso, el evento "no existe".
      if (acceso.kind === 'none') return NO_EXISTE

      await socket.join(
        acceso.kind === 'vendor' ? salaDeVendorsDeEvento(eventId) : salaDeEvento(eventId),
      )
      return { ok: true }
    })
  }

  @SubscribeMessage('leave')
  async salir(
    @ConnectedSocket() socket: SocketRealtime,
    @MessageBody() datos: unknown,
  ): Promise<RespuestaSala> {
    const leido = salaSchema.safeParse(datos)
    if (!leido.success) return NO_EXISTE
    await socket.leave(salaDeEvento(leido.data.eventId))
    await socket.leave(salaDeVendorsDeEvento(leido.data.eventId))
    return { ok: true }
  }

  private async autenticar(socket: SocketRealtime): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown }
    const token = typeof auth.token === 'string' ? auth.token : ''
    const usuario = await autenticarAccessToken(this.tokens, this.usuarios, token)
    socket.data.userId = usuario.id
    socket.data.token = token
  }

  /**
   * Valida el cuerpo, RE-autentica y ejecuta `accion`. Todo fallo inesperado
   * (la base de datos caída) sale como `INTERNAL` en el ack: sin esto, Nest
   * emitiría `exception` y el ack no llegaría nunca — el cliente sólo vería un
   * timeout.
   */
  private async conSalaAutorizada(
    socket: SocketRealtime,
    datos: unknown,
    accion: (eventId: string, usuario: UsuarioAutenticado) => Promise<RespuestaSala>,
  ): Promise<RespuestaSala> {
    const leido = salaSchema.safeParse(datos)
    if (!leido.success) return NO_EXISTE

    try {
      let usuario: UsuarioAutenticado
      try {
        usuario = await autenticarAccessToken(this.tokens, this.usuarios, socket.data.token)
      } catch (error) {
        if (error instanceof UnauthorizedError) return { ok: false, code: 'UNAUTHORIZED' }
        throw error
      }
      return await accion(leido.data.eventId, usuario)
    } catch (error) {
      this.registro.error(
        `Fallo al unir un socket a una sala userId=${socket.data.userId} eventId=${leido.data.eventId}`,
        error instanceof Error ? error.stack : String(error),
      )
      return { ok: false, code: 'INTERNAL' }
    }
  }
}

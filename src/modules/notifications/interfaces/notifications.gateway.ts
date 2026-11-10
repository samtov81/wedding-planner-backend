import { Inject, Logger, type OnModuleDestroy } from '@nestjs/common'
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
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
import {
  EVENT_REPOSITORY,
  type EventRepository,
} from '@/modules/events/application/event.repository'
import { USER_REPOSITORY, type UserRepository } from '@/modules/users/application/user.repository'
import { UnauthorizedError } from '@/shared/domain'

import {
  EVENTO_PRESENCIA,
  LATIDO_MS,
  PRESENCE_PORT,
  PRESENCIA_GRACIA_MS,
  type PresencePort,
} from '../application/presence.port'
import {
  NAMESPACE_REALTIME,
  salaDeEvento,
  salaDeUsuario,
  salaDeVendorsDeEvento,
} from '../application/salas'

/**
 * Cuántos `join` acepta un socket por minuto. Cada `join` reautentica (una
 * lectura de usuario) y resuelve el acceso al evento (otra): sin límite, un
 * cliente con un bucle roto — o alguien probando ids de evento — convierte una
 * sola conexión en un martillo contra la base de datos. 20/min deja sitio de
 * sobra para el uso real (un `join` por pantalla abierta) y corta el abuso.
 */
const JOINS_POR_MINUTO = 20

/** Fichas por milisegundo: el cubo se rellena de forma continua, no a saltos. */
const RECARGA_POR_MS = JOINS_POR_MINUTO / 60_000

/**
 * Lo que el servidor guarda en cada socket. El token NO se registra nunca.
 * `fichas`/`recargadoEn` son el cubo de fichas del límite de `join`: vive en el
 * socket, así que se va con él y no hay nada que limpiar.
 */
interface DatosDeSocket {
  userId: string
  token: string
  fichas: number
  recargadoEn: number
}

type SocketRealtime = Socket<Record<string, never>, Record<string, never>, never, DatosDeSocket>

/**
 * DESIGN-GAP (brief de la tarea 9): el brief escribe el ack del límite como
 * `{ ok: false, error: 'RATE_LIMITED' }`. Aquí va en `code`, como los otros
 * tres rechazos que ya existían: un mismo ack con dos nombres para el mismo
 * campo obligaría a cada cliente a mirar los dos. El valor, `RATE_LIMITED`, es
 * el del brief.
 */
export type RespuestaSala =
  { ok: true } | { ok: false; code: 'NOT_FOUND' | 'UNAUTHORIZED' | 'INTERNAL' | 'RATE_LIMITED' }

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
 * `event:<id>`; un vendor BOOKED en `event:<id>:vendors`. `event:<id>` ya no
 * lleva sólo datos de invitados (también moodboard y presencia), pero sigue
 * siendo de quien planifica: lo que un proveedor puede ver le llega por su sala
 * de usuario o por `event:<id>:vendors`, que lleva la presencia de los miembros.
 *
 * Presencia (spec 2026-11-09 §8; mecánica en `PresencePort`): cada socket que
 * conecta se registra y cada uno que se va se borra; las transiciones se
 * anuncian con `presence.changed { userId, online }` a las salas de los eventos
 * en los que participa el usuario (`listarParticipaciones`):
 *  - un MIEMBRO, a `event:<id>` y a `event:<id>:vendors`;
 *  - un PROVEEDOR, sólo a `event:<id>`: un proveedor no sabe cuándo está
 *    conectado otro (spec 2026-11-09 §8).
 * La salida espera una GRACIA (`PRESENCIA_GRACIA_MS`) antes de confirmar: este
 * mismo gateway echa cada socket al caducar su token (15 min) y el cliente
 * vuelve al momento; sin gracia, todos parpadearían offline/online. Un latido
 * cada `LATIDO_MS` renueva los sockets de ESTE proceso; si el proceso muere,
 * caducan solos.
 *
 * La presencia es un extra: si Redis falla al registrar o anunciar, se registra
 * el error y la conexión sigue. Alternativa descartada: rechazar el socket; el
 * canal de tiempo real sirve para mucho más que el punto verde, y perderlo
 * entero por él sería un mal cambio.
 *
 * Cierre: desde `onModuleDestroy` no se toca la presencia. Los sockets que la
 * app echa al cerrar (un despliegue) se quedan registrados hasta caducar, así
 * que, si reconectan a otra réplica dentro de 75 s, nadie los ve parpadear.
 * Además, la conexión de Redis de la presencia ya puede estar cerrada.
 *
 * CORS: lo pone `RedisIoAdapter` con la allowlist del entorno, la misma que el
 * HTTP. Aquí no: el CORS de Socket.IO es del servidor, no de un namespace, y el
 * decorador sólo admite valores fijos.
 */
@WebSocketGateway({ namespace: NAMESPACE_REALTIME })
export class NotificationsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() readonly server!: Namespace

  private readonly registro = new Logger(NotificationsGateway.name)

  /**
   * El registro de presencia de cada socket conectado (se quita al irse).
   * `handleDisconnect` lo espera antes de borrar: si un socket se va mientras
   * `conectar` sigue en Redis, el `ZREM` llegaría antes que el `ZADD` y
   * dejaría un fantasma. Nunca rechaza (`registrarConexion` captura).
   */
  private readonly registrosEnVuelo = new Map<string, Promise<void>>()
  private readonly gracias = new Set<NodeJS.Timeout>()
  private latido: NodeJS.Timeout | undefined
  private cerrando = false

  constructor(
    private readonly tokens: TokenService,
    @Inject(USER_REPOSITORY) private readonly usuarios: UserRepository,
    private readonly accesoAEventos: EventAccessService,
    @Inject(EVENT_REPOSITORY) private readonly eventos: EventRepository,
    @Inject(PRESENCE_PORT) private readonly presencia: PresencePort,
    @Inject(PRESENCIA_GRACIA_MS) private readonly graciaMs: number,
  ) {}

  afterInit(namespace: Namespace): void {
    // `unref`: el latido no mantiene vivo un proceso que ya no tiene otra cosa que hacer.
    this.latido = setInterval(() => void this.latir(namespace), LATIDO_MS).unref()

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
    // El registro arranca ANTES del `join` para que `handleDisconnect` lo
    // encuentre aunque el socket se vaya mientras se une a su sala.
    const registro = this.registrarConexion(socket.data.userId, socket.id)
    this.registrosEnVuelo.set(socket.id, registro)
    await socket.join(salaDeUsuario(socket.data.userId))
    await registro
  }

  handleDisconnect(socket: SocketRealtime): void {
    const registro = this.registrosEnVuelo.get(socket.id)
    this.registrosEnVuelo.delete(socket.id)
    // Un socket que el middleware rechazó no tiene usuario ni registro.
    if (this.cerrando || registro === undefined) return
    void this.registrarSalida(socket.data.userId, socket.id, registro)
  }

  onModuleDestroy(): void {
    this.cerrando = true
    clearInterval(this.latido)
    for (const temporizador of this.gracias) clearTimeout(temporizador)
    this.gracias.clear()
  }

  @SubscribeMessage('join')
  async unirse(
    @ConnectedSocket() socket: SocketRealtime,
    @MessageBody() datos: unknown,
  ): Promise<RespuestaSala> {
    // ANTES de validar el cuerpo y de reautenticar: un `join` pasado de ritmo
    // no llega a tocar la base de datos, que es de lo que protege el límite.
    if (!this.tomarFicha(socket)) return { ok: false, code: 'RATE_LIMITED' }

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

  /** Registra el socket y, si el usuario no estaba anunciado, anuncia online. Nunca rechaza. */
  private async registrarConexion(userId: string, socketId: string): Promise<void> {
    try {
      if (await this.presencia.conectar(userId, socketId, new Date())) {
        await this.anunciar(userId, true)
      }
    } catch (error) {
      this.registrarFallo(`Fallo al registrar la presencia userId=${userId}`, error)
    }
  }

  /**
   * Borra el socket y programa la confirmación tras la gracia. Se programa
   * aunque el borrado falle: el socket caducará solo, y `confirmarSalida` lo
   * verá vivo y no anunciará nada falso.
   */
  private async registrarSalida(
    userId: string,
    socketId: string,
    registro: Promise<void>,
  ): Promise<void> {
    try {
      await registro
      await this.presencia.desconectar(userId, socketId)
    } catch (error) {
      this.registrarFallo(`Fallo al borrar la presencia userId=${userId}`, error)
    }
    if (this.cerrando) return
    const temporizador = setTimeout(() => {
      this.gracias.delete(temporizador)
      void this.confirmarSalida(userId)
    }, this.graciaMs)
    this.gracias.add(temporizador)
  }

  private async confirmarSalida(userId: string): Promise<void> {
    try {
      if (await this.presencia.confirmarSalida(userId, new Date())) {
        await this.anunciar(userId, false)
      }
    } catch (error) {
      this.registrarFallo(`Fallo al confirmar la salida userId=${userId}`, error)
    }
  }

  /**
   * UNA emisión a todas las salas: Socket.IO entrega una sola vez a cada
   * socket aunque esté en varias. Por `this.server`, que pasa por el adapter de
   * Redis y llega a los sockets de todas las réplicas. Sin participaciones no
   * se emite: `to([])` sería un broadcast a TODO el namespace.
   */
  private async anunciar(userId: string, online: boolean): Promise<void> {
    const participaciones = await this.eventos.listarParticipaciones(userId)
    if (participaciones.length === 0) return
    const salas = participaciones.flatMap(({ eventId, comoProveedor }) =>
      comoProveedor
        ? [salaDeEvento(eventId)]
        : [salaDeEvento(eventId), salaDeVendorsDeEvento(eventId)],
    )
    this.server.to(salas).emit(EVENTO_PRESENCIA, { userId, online })
  }

  /** Renueva los sockets que tiene ESTE proceso; los de otras réplicas los renuevan ellas. */
  private async latir(namespace: Namespace): Promise<void> {
    const sockets = [...namespace.sockets.values()].map((socket) => ({
      userId: (socket as SocketRealtime).data.userId,
      socketId: socket.id,
    }))
    try {
      await this.presencia.renovar(sockets, new Date())
    } catch (error) {
      this.registrarFallo('Fallo al renovar la presencia', error)
    }
  }

  private registrarFallo(mensaje: string, error: unknown): void {
    this.registro.error(mensaje, error instanceof Error ? error.stack : String(error))
  }

  private async autenticar(socket: SocketRealtime): Promise<void> {
    const auth = socket.handshake.auth as { token?: unknown }
    const token = typeof auth.token === 'string' ? auth.token : ''
    const { usuario, expiraEn } = await autenticarAccessToken(this.tokens, this.usuarios, token)
    socket.data.userId = usuario.id
    socket.data.token = token
    socket.data.fichas = JOINS_POR_MINUTO
    socket.data.recargadoEn = Date.now()

    // El token caduca a una hora FIJA, pero el socket no se reautentica solo:
    // sin esto, una conexión abierta sobrevive a su propio token. `join` ya
    // reautentica, pero quien sólo escucha no emite nada, así que nadie
    // volvería a mirar el token. Se le echa al `exp` y que reconecte con uno
    // nuevo. `Math.max(…, 0)` por si el token caducó entre la firma y el
    // handshake: `setTimeout` con un negativo dispara igualmente al instante,
    // pero dejarlo explícito evita depender de eso.
    const restante = expiraEn.getTime() - Date.now()
    const temporizador = setTimeout(() => socket.disconnect(true), Math.max(restante, 0))
    socket.once('disconnect', () => clearTimeout(temporizador))
  }

  /**
   * Cubo de fichas POR SOCKET: se recarga de forma continua hasta
   * `JOINS_POR_MINUTO` y cada `join` gasta una. Por socket y en memoria, no en
   * Redis: lo que se protege es el coste que una conexión concreta le impone a
   * esta instancia, y un contador compartido costaría un viaje a Redis por
   * `join` — justo el trabajo que se quiere evitar.
   */
  private tomarFicha(socket: SocketRealtime): boolean {
    const ahora = Date.now()
    socket.data.fichas = Math.min(
      JOINS_POR_MINUTO,
      socket.data.fichas + (ahora - socket.data.recargadoEn) * RECARGA_POR_MS,
    )
    socket.data.recargadoEn = ahora
    if (socket.data.fichas < 1) return false
    socket.data.fichas -= 1
    return true
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
        ;({ usuario } = await autenticarAccessToken(this.tokens, this.usuarios, socket.data.token))
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

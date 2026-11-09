/**
 * Presencia "en línea" (spec 2026-11-09 §8): un usuario está en línea mientras
 * tiene AL MENOS UN socket conectado al namespace `/realtime`, en cualquier
 * pantalla. Pensada para que la reutilicen después la mensajería u otras
 * vistas, así que no sabe nada del moodboard: sólo de usuarios y sockets.
 *
 * El estado vive fuera del proceso (Redis): el gateway puede tener varias
 * réplicas y quien pregunta `enLinea` (un caso de uso) no tiene por qué ser el
 * proceso que tiene el socket. Registro POR SOCKET con caducidad renovada por
 * latido, no un contador `INCR/DECR`: un proceso que muere no puede
 * decrementar, y su contador dejaría a alguien "en línea" para siempre. Con un
 * registro que caduca, los sockets de un proceso muerto desaparecen solos a
 * los `TTL_SOCKET_MS`.
 *
 * El puerto separa "registrar" de "decidir si se anuncia": `conectar` y
 * `confirmarSalida` devuelven si hay que emitir la transición, y esa decisión
 * es atómica en el adaptador. Dos réplicas que conectan o desconectan sockets
 * del mismo usuario a la vez no pueden anunciar las dos el mismo cambio.
 *
 * `ahora` llega de fuera para que los tests muevan el reloj sin dormir.
 */
export interface PresencePort {
  /** Registra el socket. true si el usuario NO estaba anunciado en línea (hay que emitir online). */
  conectar(userId: string, socketId: string, ahora: Date): Promise<boolean>
  /** Renueva la caducidad de esos sockets (latido). */
  renovar(sockets: { userId: string; socketId: string }[], ahora: Date): Promise<void>
  desconectar(userId: string, socketId: string): Promise<void>
  /** Tras la gracia: true si ya no tiene sockets vivos y estaba anunciado (hay que emitir offline). */
  confirmarSalida(userId: string, ahora: Date): Promise<boolean>
  enLinea(userIds: string[], ahora: Date): Promise<Set<string>>
}

export const PRESENCE_PORT = Symbol('PRESENCE_PORT')

/**
 * Cuánto vive el registro de un socket sin latido. Dos latidos y medio: un
 * latido perdido (un GC largo, Redis lento un instante) no tumba a nadie, y un
 * proceso muerto deja de contar en poco más de un minuto.
 */
export const TTL_SOCKET_MS = 75_000

/** Cada cuánto renueva el gateway los sockets que tiene. */
export const LATIDO_MS = 30_000

/**
 * Ventana de gracia OBLIGATORIA (spec 2026-11-09 §8) entre que se va el último
 * socket y se anuncia offline. El gateway echa cada socket cuando caduca su
 * access token (15 min) y el cliente reconecta al momento; lo mismo al recargar
 * la página. Sin gracia, todo el mundo parpadearía offline/online cada 15
 * minutos. 20 s cubren una reconexión con renovación de token de sobra.
 */
export const GRACIA_MS = 20_000

/**
 * Token de inyección de la gracia. Existe SÓLO para que un e2e la acorte: con
 * 20 s reales, probar el `online: false` haría el test lento. El módulo lo
 * provee con `GRACIA_MS`. Alternativa descartada: leerla del entorno; nadie lee
 * `process.env` fuera de `src/config`, y una variable de entorno invitaría a
 * cambiarla en producción, donde 20 s es una decisión del spec.
 */
export const PRESENCIA_GRACIA_MS = Symbol('PRESENCIA_GRACIA_MS')

/** Evento de Socket.IO que anuncia una transición: `{ userId, online }`. */
export const EVENTO_PRESENCIA = 'presence.changed'

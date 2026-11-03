import { alcanza, type Marca } from './conversacion'

/**
 * Reglas puras de la sala de grupo del evento (spec 2026-11-02, parte 2).
 *
 * La sala es una conversación `EVENT_ROOM` con una clave fija por evento: el
 * `UNIQUE` de `pairKey` (y el CHECK `conversations_sala_clave`) garantizan una
 * por evento aunque dos peticiones la creen a la vez. Alternativa descartada:
 * crearla en `CreateEventUseCase`, que obligaría a `events` a llamar a
 * `messaging` (acoplamiento nuevo y riesgo de ciclo); se crea perezosa al
 * abrirla o listar las salas, y para el usuario "existe desde el principio".
 */
export const claveDeSala = (eventId: string): string => `room:${eventId}`

/** Las dos marcas de un participante (como `MarcasDeParticipante` del puerto). */
export interface MarcasDe {
  deliveredUpTo: Marca | null
  readUpTo: Marca | null
}

/**
 * "Leído por N de M": M son los destinatarios FIJADOS al enviar (quienes
 * estaban en la sala, sin el remitente), no los participantes de hoy; así ni
 * quien sale ni quien entra después cambian la cuenta de un mensaje viejo. Un
 * no destinatario con marca mayor (alguien que entró tarde y leyó el
 * historial) no suma. Las marcas son las de la parte 1: una por participante.
 */
export function resumenDeLectura(
  destinatarios: readonly string[],
  marcas: ReadonlyMap<string, MarcasDe>,
  mensaje: Marca,
): { total: number; delivered: number; read: number } {
  let delivered = 0
  let read = 0
  for (const id of destinatarios) {
    const m = marcas.get(id)
    // Leer implica haber recibido aunque la marca de recibido vaya por detrás.
    const leido = alcanza(m?.readUpTo ?? null, mensaje)
    if (leido) read += 1
    if (leido || alcanza(m?.deliveredUpTo ?? null, mensaje)) delivered += 1
  }
  return { total: destinatarios.length, delivered, read }
}

/** Quién de los destinatarios lo leyó y quién no, en el orden de `destinatarios`. */
export function lectoresDe(
  destinatarios: readonly string[],
  marcas: ReadonlyMap<string, MarcasDe>,
  mensaje: Marca,
): { read: string[]; unread: string[] } {
  const read: string[] = []
  const unread: string[] = []
  for (const id of destinatarios) {
    if (alcanza(marcas.get(id)?.readUpTo ?? null, mensaje)) read.push(id)
    else unread.push(id)
  }
  return { read, unread }
}

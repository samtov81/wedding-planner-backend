import { MensajeInvalidoError, NombreDeAdjuntoInvalidoError } from './messaging-errors'

/**
 * Papel con el que alguien participa en un evento a efectos de mensajería.
 * Es un tipo propio y no el de `events`: el `domain/` de un módulo no importa
 * el de otro. El caso de uso traduce el acceso efectivo a este valor.
 */
export type RolEnEvento = 'COUPLE' | 'PLANNER' | 'VENDOR'

/** Tope de caracteres de un mensaje, tras recortar. Lo repite el CHECK de la base. */
export const MAX_CARACTERES_MENSAJE = 2000

/**
 * Clave única de una conversación individual: evento + las dos personas sin
 * orden (`menor` y `mayor` por comparación de cadenas). Con ella "abrir otra
 * vez" devuelve la existente y la base garantiza una por trío con un `UNIQUE`.
 * Alternativa descartada: unique compuesto (eventId, a, b) con a < b, que
 * obligaría a ordenar en cada consulta y no vale para la sala de la parte 2.
 */
export function claveDePar(eventId: string, a: string, b: string): string {
  const [menor, mayor] = a <= b ? [a, b] : [b, a]
  return `${eventId}:${menor}:${mayor}`
}

/**
 * Miembro↔miembro y miembro↔proveedor sí; proveedor↔proveedor nunca (son
 * posible competencia y no deben verse entre sí).
 */
export function parPermitido(a: RolEnEvento, b: RolEnEvento): boolean {
  return !(a === 'VENDOR' && b === 'VENDOR')
}

/**
 * Recorta el texto y exige entre 1 y `MAX_CARACTERES_MENSAJE` caracteres, o
 * entre 0 y el tope si el mensaje lleva adjunto (`conAdjunto`): un archivo
 * solo, sin texto, es un mensaje válido. Se guarda tal cual, sin HTML. Cuenta
 * con `Array.from` para que un emoji sea un carácter, igual que `char_length`
 * en Postgres (que cuenta puntos de código). Alternativa descartada: una
 * función aparte para el cuerpo con adjunto; el tope se repetiría y podrían
 * divergir.
 */
export function normalizarCuerpo(texto: string, conAdjunto = false): string {
  const recortado = texto.trim()
  const longitud = Array.from(recortado).length
  if ((longitud === 0 && !conAdjunto) || longitud > MAX_CARACTERES_MENSAJE) {
    throw new MensajeInvalidoError()
  }
  return recortado
}

/** Tope de caracteres del nombre de un adjunto, tras recortar. Lo repite el CHECK de la base. */
export const MAX_NOMBRE_ADJUNTO = 200

/**
 * Recorta el nombre del adjunto y exige entre 1 y `MAX_NOMBRE_ADJUNTO`
 * caracteres (contados con `Array.from`, como el cuerpo), sin `/` ni `\`. Se
 * acepta cualquier otro unicode: el nombre es sólo una etiqueta, nunca una
 * ruta. Alternativa descartada: sustituir las barras por `_`; el cliente ya
 * envía un nombre saneado y uno rechazado delata un bug en vez de ocultarlo.
 */
export function normalizarNombreDeAdjunto(nombre: string): string {
  const recortado = nombre.trim()
  const longitud = Array.from(recortado).length
  if (longitud === 0 || longitud > MAX_NOMBRE_ADJUNTO || /[/\\]/.test(recortado)) {
    throw new NombreDeAdjuntoInvalidoError()
  }
  return recortado
}

/** Marca "hasta aquí": el `createdAt` y el `id` de un mensaje. */
export interface Marca {
  at: Date
  id: string
}

/** Orden total por (at, id): negativo si `x` va antes que `y`. */
function comparar(x: Marca, y: Marca): number {
  const dif = x.at.getTime() - y.at.getTime()
  if (dif !== 0) return dif
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0
}

/** Las marcas sólo avanzan: devuelve la mayor por (at, id). */
export function avanzar(actual: Marca | null, nueva: Marca): Marca {
  return actual !== null && comparar(actual, nueva) >= 0 ? actual : nueva
}

/** ¿La marca ya cubre el mensaje (marca ≥ mensaje)? Sin marca, no. */
export function alcanza(marca: Marca | null, mensaje: Marca): boolean {
  return marca !== null && comparar(marca, mensaje) >= 0
}

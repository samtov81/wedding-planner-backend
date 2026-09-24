import { UnprocessableError } from './domain-error'

export class UbicacionInvalidaError extends UnprocessableError {
  constructor() {
    super('La ubicación necesita dirección y coordenadas válidas', 'INVALID_LOCATION')
  }
}

/**
 * Un punto elegido en el mapa. Vive en `shared/domain` porque lo usan el
 * evento (venue) y cada ítem del cronograma, y un módulo no puede importar el
 * dominio de otro.
 *
 * Coordenadas en `number`: 6 decimales (~11 cm) caben de sobra en un double.
 * La columna es `Decimal(9,6)` para que no aparezca ruido al leerla.
 */
export interface Ubicacion {
  name: string | null
  address: string
  lat: number
  lng: number
  mapboxId: string | null
}

export interface EntradaUbicacion {
  name?: string | null | undefined
  address: string
  lat: number
  lng: number
  mapboxId?: string | null | undefined
}

function textoOpcional(valor: string | null | undefined): string | null {
  const recortado = valor?.trim() ?? ''
  return recortado === '' ? null : recortado
}

export function crearUbicacion(entrada: EntradaUbicacion): Ubicacion {
  const address = entrada.address.trim()
  const { lat, lng } = entrada
  if (address === '') throw new UbicacionInvalidaError()
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) throw new UbicacionInvalidaError()
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) throw new UbicacionInvalidaError()
  return {
    name: textoOpcional(entrada.name),
    address,
    lat,
    lng,
    mapboxId: textoOpcional(entrada.mapboxId),
  }
}

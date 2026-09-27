import type { Event } from './event'

export type CampoPublicable =
  'name' | 'weddingDate' | 'timezone' | 'currency' | 'totalBudget' | 'venue'

export type DatosPublicables = Pick<
  Event,
  'name' | 'weddingDate' | 'timezone' | 'currency' | 'totalBudget' | 'venue'
>

/**
 * Lo mínimo para que un evento deje de ser borrador. Se aplica al publicar y
 * en cada PATCH sobre un evento ACTIVE: publicado, se puede editar TODO, pero
 * no dejarlo a medias. El orden es fijo para que la UI no baile.
 */
export function camposFaltantesParaPublicar(evento: DatosPublicables): CampoPublicable[] {
  const faltantes: CampoPublicable[] = []
  if (evento.name.trim() === '') faltantes.push('name')
  if (evento.weddingDate === null) faltantes.push('weddingDate')
  if (evento.timezone.trim() === '') faltantes.push('timezone')
  if (evento.currency.trim() === '') faltantes.push('currency')
  if (evento.totalBudget === null) faltantes.push('totalBudget')
  if (evento.venue === null) faltantes.push('venue')
  return faltantes
}

export type EstadoPaso = 'completo' | 'parcial' | 'vacio'

export interface Completitud {
  general: EstadoPaso
  venue: EstadoPaso
  schedule: EstadoPaso
  budget: EstadoPaso
}

/**
 * Solo alimenta el stepper del wizard; NO decide si se puede publicar (eso es
 * `camposFaltantesParaPublicar`). Cronograma y proveedores son opcionales
 * para publicar, pero el stepper enseña si ya se tocaron.
 */
export function completitud(evento: Event): Completitud {
  const tieneTotal = evento.totalBudget !== null
  const tieneVendors = evento.conteos.vendors > 0
  return {
    // `name` siempre existe (es obligatorio desde el primer guardado) y
    // timezone/currency tienen default: lo que distingue es la fecha.
    general: evento.weddingDate === null ? 'parcial' : 'completo',
    venue: evento.venue === null ? 'vacio' : 'completo',
    schedule: evento.conteos.scheduleItems > 0 ? 'completo' : 'vacio',
    budget:
      tieneTotal && tieneVendors ? 'completo' : tieneTotal || tieneVendors ? 'parcial' : 'vacio',
  }
}

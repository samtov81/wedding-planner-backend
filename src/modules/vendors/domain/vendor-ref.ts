import { UnprocessableError } from '@/shared/domain'

/**
 * O bien apunta a una `VendorProfile` del marketplace, o bien trae los datos
 * de un proveedor externo sin cuenta. Unión discriminada a propósito: el
 * consumidor tiene que decidir qué hace en cada caso, igual que `EventAccess`
 * en el módulo de eventos.
 */
export type VendorRef =
  | { kind: 'linked'; vendorProfileId: string }
  | { kind: 'external'; name: string; email: string | null; phone: string | null }

export class VendorRefAmbiguaError extends UnprocessableError {
  constructor() {
    super(
      'Un proveedor del evento es o bien una ficha del marketplace o bien externo, no ambos',
      'VENDOR_REF_AMBIGUA',
    )
  }
}

export class VendorRefVaciaError extends UnprocessableError {
  constructor() {
    super(
      'Indica una ficha del marketplace o los datos de un proveedor externo',
      'VENDOR_REF_VACIA',
    )
  }
}

export interface EntradaVendorRef {
  vendorProfileId?: string | undefined
  externalName?: string | undefined
  externalEmail?: string | undefined
  externalPhone?: string | undefined
}

/**
 * Réplica a nivel de aplicación del CHECK `event_vendors_origen_exclusivo`
 * (Tarea 3): el CHECK garantiza la integridad en base de datos, pero produce
 * un error de Postgres sin explicar qué está mal. Este value object da un 422
 * con el motivo ANTES de llegar ahí. Las dos capas responden a preguntas
 * distintas y ninguna sustituye a la otra.
 *
 * DESIGN-GAP (ordenado por el controlador de la revisión, ronda 1, hallazgo
 * Important #1 — C11): el brief sólo comprobaba `vendorProfileId` y
 * `externalName` para detectar ambigüedad. Con eso, `{ vendorProfileId,
 * externalEmail, externalPhone }` pasaba como `linked` y el email/teléfono se
 * tiraban en silencio al construir la fila — un 201 que miente sobre qué se
 * guardó, e inconsistente con `externalName` en la misma posición, que sí
 * daba 422. Se corta aquí, no en el DTO: `parseVendorRef` es el único sitio
 * que conoce la regla completa de exclusividad, y el DTO ya delega en él a
 * propósito (ver docblock de `createEventVendorSchema`) para no duplicarla.
 * Cualquier `externalEmail`/`externalPhone` no vacío junto a un
 * `vendorProfileId` no vacío es ahora tan ambiguo como `externalName`.
 */
export function parseVendorRef(entrada: EntradaVendorRef): VendorRef {
  const enlazado = entrada.vendorProfileId?.trim() ?? ''
  const nombre = entrada.externalName?.trim() ?? ''
  const email = entrada.externalEmail?.trim() ?? ''
  const telefono = entrada.externalPhone?.trim() ?? ''

  if (enlazado !== '' && (nombre !== '' || email !== '' || telefono !== '')) {
    throw new VendorRefAmbiguaError()
  }
  if (enlazado === '' && nombre === '') throw new VendorRefVaciaError()

  if (enlazado !== '') return { kind: 'linked', vendorProfileId: enlazado }

  return {
    kind: 'external',
    name: nombre,
    email: email === '' ? null : email,
    phone: telefono === '' ? null : telefono,
  }
}

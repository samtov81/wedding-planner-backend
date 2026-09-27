import { NotFoundError } from '@/shared/domain'

export class GastoNoEncontradoError extends NotFoundError {
  constructor() {
    super('El gasto no existe en este evento', 'EXPENSE_NOT_FOUND')
  }
}

/** Mismo código que `EventVendorNoEncontradoError` de vendors: el cliente ve un único 404. */
export class ProveedorDelEventoNoEncontradoError extends NotFoundError {
  constructor() {
    super('El proveedor no existe en este evento', 'EVENT_VENDOR_NOT_FOUND')
  }
}

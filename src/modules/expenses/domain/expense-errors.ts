import { ConflictError, NotFoundError, UnprocessableError } from '@/shared/domain'

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

export class SubtotalInvalidoError extends UnprocessableError {
  constructor() {
    super('El subtotal debe ser mayor que 0 y no superar el importe', 'INVALID_SUBTOTAL')
  }
}

export class NumeroDeFacturaRepetidoError extends ConflictError {
  constructor() {
    super('Ya existe un gasto con ese número de factura en este evento', 'INVOICE_NUMBER_TAKEN')
  }
}

/** 404 también cuando el gasto existe pero el proveedor no lo cobró: no se revela su existencia. */
export class PagoRecibidoNoEncontradoError extends NotFoundError {
  constructor() {
    super('El pago no existe', 'VENDOR_PAYMENT_NOT_FOUND')
  }
}

export class ArchivoDeFacturaNoEncontradoError extends NotFoundError {
  constructor() {
    super('El gasto no tiene archivo de factura', 'INVOICE_FILE_NOT_FOUND')
  }
}

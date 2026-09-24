import { UnprocessableError } from './domain-error'

export class MontoInvalidoError extends UnprocessableError {
  constructor() {
    super('El monto no es válido: hasta 10 dígitos enteros y 2 decimales', 'INVALID_AMOUNT')
  }
}

/** Hasta 10 dígitos enteros y 2 decimales: lo que cabe en `Decimal(12,2)`. */
// eslint-disable-next-line security/detect-unsafe-regex
const MONTO = /^\d{1,10}(\.\d{1,2})?$/

/**
 * Los montos viajan como string con dos decimales ("45000.00") en el dominio y
 * en la API: un `number` de JS no representa 0.1 exacto, y sumar gastos en
 * coma flotante acaba mostrando 0.30000000000000004 en una factura.
 *
 * Un `number` se convierte con `toFixed(2)` SOLO si ya tiene como mucho dos
 * decimales, para no redondear en silencio lo que el cliente mandó.
 */
export function normalizarMonto(valor: number | string): string {
  let texto: string
  if (typeof valor === 'number') {
    if (!Number.isFinite(valor) || valor < 0) throw new MontoInvalidoError()
    if (Math.round(valor * 100) / 100 !== valor) throw new MontoInvalidoError()
    texto = valor.toFixed(2)
  } else {
    texto = valor.trim()
  }
  if (!MONTO.test(texto)) throw new MontoInvalidoError()
  const [entero = '0', decimales = ''] = texto.split('.')
  return `${String(BigInt(entero))}.${decimales.padEnd(2, '0')}`
}

/** "12.34" → 1234n. Solo acepta montos ya normalizados (o negativos de `deCentimos`). */
export function aCentimos(monto: string): bigint {
  const negativo = monto.startsWith('-')
  const [entero = '0', decimales = '00'] = (negativo ? monto.slice(1) : monto).split('.')
  const valor = BigInt(entero) * 100n + BigInt(decimales.padEnd(2, '0').slice(0, 2))
  return negativo ? -valor : valor
}

export function deCentimos(centimos: bigint): string {
  const negativo = centimos < 0n
  const absoluto = negativo ? -centimos : centimos
  const texto = `${String(absoluto / 100n)}.${String(absoluto % 100n).padStart(2, '0')}`
  return negativo ? `-${texto}` : texto
}

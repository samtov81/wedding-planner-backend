/**
 * Monedas soportadas (ISO 4217). Lista acotada a propósito: cada una es una
 * decisión de producto (formato, mercados). El frontend usa la misma lista.
 */
export const MONEDAS = [
  'USD',
  'EUR',
  'MXN',
  'COP',
  'ARS',
  'CLP',
  'PEN',
  'BRL',
  'GBP',
  'CAD',
] as const
export type Moneda = (typeof MONEDAS)[number]

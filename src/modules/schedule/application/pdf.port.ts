import type { DocumentoCronograma } from './pdf-cronograma'

/**
 * Puerto del generador de PDF (spec 2026-11-10 §8). Recibe el documento YA
 * compuesto: nunca ve ítems ni roles, así que no puede filtrar mal lo que no
 * conoce. Alternativa descartada: que el caso de uso llame a `pdfkit`
 * directamente; `application/` no importa librerías de infraestructura.
 */
export interface GeneradorPdf {
  generar(doc: DocumentoCronograma): Promise<Buffer>
}

export const GENERADOR_PDF = Symbol('GENERADOR_PDF')

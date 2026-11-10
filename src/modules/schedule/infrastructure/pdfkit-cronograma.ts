import PDFDocument from 'pdfkit'

import type { DocumentoCronograma } from '../application/pdf-cronograma'
import type { GeneradorPdf } from '../application/pdf.port'

/**
 * Todo lo que Helvetica (WinAnsi) no sabe pintar. pdfkit no lanza con un
 * carácter fuera de la fuente: escribe un byte cualquiera y sale basura en el
 * PDF (un emoji o un ✓ se vuelven símbolos al azar). Se deja pasar Latin-1
 * (acentos y ñ) y la puntuación que WinAnsi sí tiene.
 */
// eslint-disable-next-line no-control-regex -- los controles también quedan fuera de Helvetica
const FUERA_DE_WINANSI = /[^\u0000-ÿ–—‘’“”•…€™]/gu

/** ✓ (confirmado) no existe en Helvetica: se escribe con palabras. */
export function aWinAnsi(texto: string): string {
  return texto.replaceAll(' ✓', ' [confirmado]').replace(FUERA_DE_WINANSI, '?')
}

const ESTADOS: Record<string, string> = {
  PENDING: 'Pendiente',
  IN_PROGRESS: 'En curso',
  DONE: 'Hecho',
}

/**
 * Generador con `pdfkit` (spec 2026-11-10 §8): corre en el proceso de la API,
 * sin navegador. Alternativa descartada: `@react-pdf/renderer`, más pesado y
 * sin necesidad para un documento de texto. Helvetica es una fuente estándar
 * del PDF (no se incrusta) y cubre los acentos del español.
 *
 * `compress: false` deja los flujos de contenido legibles, para que un test
 * pueda comprobar si el texto de una nota está o no. Por defecto se comprime.
 */
export class PdfkitCronograma implements GeneradorPdf {
  private readonly compress: boolean

  constructor(opciones: { compress?: boolean } = {}) {
    this.compress = opciones.compress ?? true
  }

  generar(doc: DocumentoCronograma): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      const pdf = new PDFDocument({ size: 'A4', margin: 50, compress: this.compress })
      const trozos: Buffer[] = []
      pdf.on('data', (t: Buffer) => trozos.push(t))
      pdf.on('end', () => resolve(Buffer.concat(trozos)))
      pdf.on('error', reject)

      try {
        pdf.font('Helvetica-Bold').fontSize(20).text(aWinAnsi(doc.titulo))
        if (doc.fecha !== '') pdf.font('Helvetica').fontSize(12).text(aWinAnsi(doc.fecha))
        pdf.moveDown()

        for (const item of doc.items) {
          pdf
            .font('Helvetica-Bold')
            .fontSize(13)
            .text(aWinAnsi(`${item.hora}  ${item.titulo}`))
          pdf.font('Helvetica').fontSize(10)
          pdf.text(`Estado: ${ESTADOS[item.estado] ?? aWinAnsi(item.estado)}`)
          if (item.lugar !== null) pdf.text(aWinAnsi(`Lugar: ${item.lugar}`))
          if (item.descripcion !== null) pdf.text(aWinAnsi(item.descripcion))
          if (item.proveedores.length > 0) {
            pdf.text(aWinAnsi(`Proveedores: ${item.proveedores.join(', ')}`))
          }
          if (item.notas.length > 0) {
            pdf.text('Notas:')
            for (const nota of item.notas) pdf.text(aWinAnsi(`- ${nota}`), { indent: 10 })
          }
          pdf.moveDown()
        }
        pdf.end()
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }
}

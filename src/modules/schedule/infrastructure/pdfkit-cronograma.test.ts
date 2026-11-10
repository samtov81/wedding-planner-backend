import { textoDelPdf } from '../../../../test/support/texto-pdf'
import type { DocumentoCronograma } from '../application/pdf-cronograma'
import { aWinAnsi, PdfkitCronograma } from './pdfkit-cronograma'

const DOC: DocumentoCronograma = {
  titulo: 'Boda de Ana y Luis',
  fecha: 'Saturday, June 12, 2027',
  items: [
    {
      hora: '16:00–17:30',
      titulo: 'Ceñida ceremonia',
      lugar: 'Iglesia, Calle 1',
      descripcion: '¿Quién trae las alianzas? Niño pequeño 😀',
      estado: 'PENDING',
      proveedores: ['Banda Sol (Música) ✓', 'Fotos Mar (Foto)'],
      notas: ['Marta: Llamar al DJ'],
    },
  ],
}

describe('PdfkitCronograma', () => {
  it('genera un PDF válido de más de 1 KB, con acentos, ñ y caracteres fuera de Helvetica', async () => {
    const buffer = await new PdfkitCronograma().generar(DOC)
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(buffer.length).toBeGreaterThan(1024)
    expect(buffer.subarray(-6).toString('latin1')).toContain('%%EOF')
  })

  it('sin comprimir, el texto de la nota está en el PDF', async () => {
    const buffer = await new PdfkitCronograma({ compress: false }).generar(DOC)
    expect(textoDelPdf(buffer)).toContain('- Marta: Llamar al DJ')
    expect(textoDelPdf(buffer)).toContain('Ceñida ceremonia')
    expect(textoDelPdf(buffer)).toContain('Banda Sol (Música) [confirmed]')
  })

  it('sin notas en el documento, el texto de la nota no está', async () => {
    const sinNotas = { ...DOC, items: DOC.items.map((i) => ({ ...i, notas: [] })) }
    const buffer = await new PdfkitCronograma({ compress: false }).generar(sinNotas)
    expect(textoDelPdf(buffer)).not.toContain('Llamar al DJ')
    expect(textoDelPdf(buffer)).not.toContain('Notes')
  })

  it('aWinAnsi escribe ✓ con palabras y sustituye lo que Helvetica no tiene', () => {
    expect(aWinAnsi('Banda (Música) ✓')).toBe('Banda (Música) [confirmed]')
    expect(aWinAnsi('Niño 😀 – ok')).toBe('Niño ? – ok')
  })
})

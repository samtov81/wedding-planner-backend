import { textoDelPdf } from '../../../../test/support/texto-pdf'
import type { DocumentoCronograma } from '../application/pdf-cronograma'
import { aWinAnsi, PdfkitCronograma } from './pdfkit-cronograma'

const DOC: DocumentoCronograma = {
  titulo: 'Boda de Ana y Luis',
  fecha: 'Saturday, June 12, 2027',
  items: [
    {
      dia: null,
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

  it('aWinAnsi compone una "é" descompuesta (e + U+0301) en vez de dejar "e?"', () => {
    const descompuesta = 'Caf' + 'e\u0301'
    expect(descompuesta).toHaveLength(5)
    expect(aWinAnsi(descompuesta)).toBe('Café')
  })

  it('pinta el subtítulo de día antes del ítem que lo lleva, y no en los que no', async () => {
    const [primero] = DOC.items
    if (primero === undefined) throw new Error('DOC sin ítems')
    const dosDias: DocumentoCronograma = {
      ...DOC,
      items: [
        { ...primero, dia: 'Friday, June 11', titulo: 'Ensayo' },
        { ...primero, dia: null, titulo: 'Cena de ensayo' },
        { ...primero, dia: 'Saturday, June 12', titulo: 'Ceremonia' },
      ],
    }
    const texto = textoDelPdf(await new PdfkitCronograma({ compress: false }).generar(dosDias))
    const lineas = texto.split('\n')
    // Línea EXACTA: la cabecera (`Saturday, June 12, 2027`) también contiene el día.
    const posicion = (linea: string) => lineas.indexOf(linea)
    const titulo = (t: string) => lineas.findIndex((l) => l.endsWith(`  ${t}`))
    expect(posicion('Friday, June 11')).toBeGreaterThan(-1)
    expect(posicion('Friday, June 11')).toBeLessThan(titulo('Ensayo'))
    expect(posicion('Saturday, June 12')).toBeGreaterThan(titulo('Cena de ensayo'))
    expect(posicion('Saturday, June 12')).toBeLessThan(titulo('Ceremonia'))
    expect(lineas.filter((l) => /^\w+day, June \d+$/.test(l))).toHaveLength(2)
  })
})

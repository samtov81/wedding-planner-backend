/**
 * El texto visible de un PDF generado SIN comprimir (`PdfkitCronograma({
 * compress: false })`). pdfkit escribe cada línea como `[<hex> kern <hex> …] TJ`
 * en WinAnsi y parte la cadena por pares de letras (kerning), de modo que
 * buscar el literal en los bytes no sirve: aquí se concatenan los fragmentos
 * hexadecimales de cada `TJ` y se decodifican como Latin-1. Una línea por `TJ`.
 */
export function textoDelPdf(pdf: Buffer): string {
  const lineas: string[] = []
  for (const [, matriz] of pdf.toString('latin1').matchAll(/\[([^\]]*)\]\s*TJ/g)) {
    const hex = [...(matriz ?? '').matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1] ?? '').join('')
    lineas.push(Buffer.from(hex, 'hex').toString('latin1'))
  }
  return lineas.join('\n')
}

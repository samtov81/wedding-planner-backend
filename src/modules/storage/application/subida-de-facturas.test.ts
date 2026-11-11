import { ArchivoDeFacturaInvalidoError, MAX_BYTES_FACTURA } from '../domain/archivo-de-factura'
import { AlmacenamientoNoDisponibleError, SubidaNoValidaError } from '../domain/imagen'
import { ObjectStorageEnMemoria } from '../infrastructure/object-storage.fake'
import { SinAlmacenamiento } from '../infrastructure/sin-almacenamiento'
import { SubidaDeFacturas } from './subida-de-facturas'

describe('SubidaDeFacturas', () => {
  const PREFIJO = 'events/E/invoices'

  describe('preparar', () => {
    it('acepta un PDF de 2 MB y devuelve una key bajo el prefijo con extensión pdf', async () => {
      const subida = new SubidaDeFacturas(new ObjectStorageEnMemoria())

      const { key, uploadUrl } = await subida.preparar(PREFIJO, 'application/pdf', 2 * 1024 * 1024)

      expect(key).toMatch(/^events\/E\/invoices\/[0-9a-f-]{36}\.pdf$/)
      expect(uploadUrl).toContain(key)
    })

    it.each([
      ['un tipo no admitido', 'text/plain', 100],
      ['más de 10 MB', 'application/pdf', MAX_BYTES_FACTURA + 1],
    ])('rechaza %s', async (_caso, tipo, bytes) => {
      const subida = new SubidaDeFacturas(new ObjectStorageEnMemoria())

      await expect(subida.preparar(PREFIJO, tipo, bytes)).rejects.toBeInstanceOf(
        ArchivoDeFacturaInvalidoError,
      )
      await expect(subida.preparar(PREFIJO, tipo, bytes)).rejects.toMatchObject({
        code: 'INVALID_INVOICE_FILE',
        httpStatus: 422,
      })
    })

    it('sin almacenamiento lanza AlmacenamientoNoDisponibleError', async () => {
      const subida = new SubidaDeFacturas(new SinAlmacenamiento())

      await expect(subida.preparar(PREFIJO, 'application/pdf', 10)).rejects.toBeInstanceOf(
        AlmacenamientoNoDisponibleError,
      )
    })
  })

  describe('confirmar', () => {
    it('devuelve tipo y tamaño de lo que hay en el bucket', async () => {
      const almacen = new ObjectStorageEnMemoria()
      const subida = new SubidaDeFacturas(almacen)
      const key = `${PREFIJO}/a.pdf`
      almacen.simularSubida(key, 'application/pdf', 1024)

      await expect(subida.confirmar(PREFIJO, key)).resolves.toEqual({
        contentType: 'application/pdf',
        bytes: 1024,
      })
    })

    it('rechaza una key de otro prefijo', async () => {
      const almacen = new ObjectStorageEnMemoria()
      const subida = new SubidaDeFacturas(almacen)
      almacen.simularSubida('events/OTRO/invoices/a.pdf', 'application/pdf', 1024)

      await expect(subida.confirmar(PREFIJO, 'events/OTRO/invoices/a.pdf')).rejects.toBeInstanceOf(
        SubidaNoValidaError,
      )
    })

    it('rechaza y borra un objeto subido con un tipo no admitido', async () => {
      const almacen = new ObjectStorageEnMemoria()
      const subida = new SubidaDeFacturas(almacen)
      const key = `${PREFIJO}/a.pdf`
      almacen.simularSubida(key, 'text/html', 1024)

      await expect(subida.confirmar(PREFIJO, key)).rejects.toBeInstanceOf(SubidaNoValidaError)
      expect(almacen.borradas).toContain(key)
    })
  })

  describe('firmarLectura', () => {
    it('pide la descarga con el nombre original codificado', async () => {
      const subida = new SubidaDeFacturas(new ObjectStorageEnMemoria())

      const url = await subida.firmarLectura(`${PREFIJO}/a.pdf`, 'factura 1.pdf')

      expect(url).toContain('as=factura%201.pdf')
    })
  })
})

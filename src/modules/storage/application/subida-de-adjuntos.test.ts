import { ArchivoAdjuntoInvalidoError } from '../domain/archivo-adjunto'
import { MAX_BYTES_FACTURA } from '../domain/archivo-de-factura'
import { SubidaNoValidaError } from '../domain/imagen'
import { ObjectStorageEnMemoria } from '../infrastructure/object-storage.fake'
import { SubidaDeAdjuntos } from './subida-de-adjuntos'

describe('SubidaDeAdjuntos', () => {
  const PREFIJO = 'events/e/messages/c'

  describe('preparar', () => {
    it('acepta un PDF y devuelve una key bajo el prefijo con extensión pdf', async () => {
      const subida = new SubidaDeAdjuntos(new ObjectStorageEnMemoria())

      const { key, uploadUrl } = await subida.preparar(PREFIJO, 'application/pdf', 1024)

      expect(key).toMatch(/^events\/e\/messages\/c\/[0-9a-f-]{36}\.pdf$/)
      expect(uploadUrl).toContain(key)
    })

    it.each([
      ['un tipo no admitido', 'image/gif', 10],
      ['más de 10 MB', 'application/pdf', MAX_BYTES_FACTURA + 1],
    ])('rechaza %s con INVALID_ATTACHMENT', async (_caso, tipo, bytes) => {
      const subida = new SubidaDeAdjuntos(new ObjectStorageEnMemoria())

      await expect(subida.preparar(PREFIJO, tipo, bytes)).rejects.toBeInstanceOf(
        ArchivoAdjuntoInvalidoError,
      )
      await expect(subida.preparar(PREFIJO, tipo, bytes)).rejects.toMatchObject({
        code: 'INVALID_ATTACHMENT',
        httpStatus: 422,
      })
    })
  })

  describe('confirmar', () => {
    it('devuelve tipo y tamaño de lo que hay en el bucket', async () => {
      const almacen = new ObjectStorageEnMemoria()
      const subida = new SubidaDeAdjuntos(almacen)
      const key = `${PREFIJO}/a.png`
      almacen.simularSubida(key, 'image/png', 2048)

      await expect(subida.confirmar(PREFIJO, key)).resolves.toEqual({
        contentType: 'image/png',
        bytes: 2048,
      })
    })

    it('rechaza y borra un objeto subido como text/plain', async () => {
      const almacen = new ObjectStorageEnMemoria()
      const subida = new SubidaDeAdjuntos(almacen)
      const key = `${PREFIJO}/a.pdf`
      almacen.simularSubida(key, 'text/plain', 100)

      await expect(subida.confirmar(PREFIJO, key)).rejects.toBeInstanceOf(SubidaNoValidaError)
      expect(almacen.borradas).toContain(key)
    })
  })

  describe('firmarLectura', () => {
    it('pide la descarga con el nombre original codificado', async () => {
      const subida = new SubidaDeAdjuntos(new ObjectStorageEnMemoria())

      const url = await subida.firmarLectura(`${PREFIJO}/a.pdf`, 'presupuesto 1.pdf')

      expect(url).toContain('as=presupuesto%201.pdf')
    })
  })
})

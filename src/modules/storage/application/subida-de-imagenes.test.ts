import { ObjectStorageEnMemoria } from '../infrastructure/object-storage.fake'
import { SinAlmacenamiento } from '../infrastructure/sin-almacenamiento'
import { MAX_BYTES_IMAGEN } from '../domain/imagen'
import { SubidaDeImagenes } from './subida-de-imagenes'

describe('SubidaDeImagenes', () => {
  const PREFIJO = 'users/u1/portfolio'

  describe('preparar', () => {
    it('inventa una key bajo el prefijo con la extensión del tipo y firma la subida', async () => {
      const subida = new SubidaDeImagenes(new ObjectStorageEnMemoria())

      const { key, uploadUrl } = await subida.preparar(PREFIJO, 'image/webp', 2048)

      expect(key).toMatch(/^users\/u1\/portfolio\/[0-9a-f-]{36}\.webp$/)
      expect(uploadUrl).toContain(key)
    })

    it.each([
      ['un tipo que no es imagen', 'application/pdf', 100],
      ['un GIF', 'image/gif', 100],
      ['más de 10 MB', 'image/jpeg', MAX_BYTES_IMAGEN + 1],
      ['cero bytes', 'image/png', 0],
    ])('rechaza %s', async (_caso, tipo, bytes) => {
      const subida = new SubidaDeImagenes(new ObjectStorageEnMemoria())

      await expect(subida.preparar(PREFIJO, tipo, bytes)).rejects.toMatchObject({
        code: 'INVALID_IMAGE',
      })
    })

    it('sin almacenamiento responde 503', async () => {
      const subida = new SubidaDeImagenes(new SinAlmacenamiento())

      await expect(subida.preparar(PREFIJO, 'image/png', 10)).rejects.toMatchObject({
        httpStatus: 503,
      })
    })
  })

  describe('confirmar', () => {
    it('acepta una key propia ya subida y válida', async () => {
      const almacen = new ObjectStorageEnMemoria()
      const subida = new SubidaDeImagenes(almacen)
      const { key } = await subida.preparar(PREFIJO, 'image/jpeg', 1024)
      almacen.simularSubida(key)

      await expect(subida.confirmar(PREFIJO, key)).resolves.toBeUndefined()
    })

    it('rechaza una key de otro prefijo aunque exista', async () => {
      const almacen = new ObjectStorageEnMemoria()
      almacen.simularSubida('users/otro/portfolio/x.jpg')
      const subida = new SubidaDeImagenes(almacen)

      await expect(subida.confirmar(PREFIJO, 'users/otro/portfolio/x.jpg')).rejects.toMatchObject({
        code: 'INVALID_UPLOAD',
      })
    })

    it('rechaza una key que intenta salir del prefijo', async () => {
      const almacen = new ObjectStorageEnMemoria()
      almacen.simularSubida(`${PREFIJO}/../../otro/x.jpg`)
      const subida = new SubidaDeImagenes(almacen)

      await expect(subida.confirmar(PREFIJO, `${PREFIJO}/../../otro/x.jpg`)).rejects.toMatchObject({
        code: 'INVALID_UPLOAD',
      })
    })

    it('rechaza una key que nunca se subió', async () => {
      const subida = new SubidaDeImagenes(new ObjectStorageEnMemoria())

      await expect(subida.confirmar(PREFIJO, `${PREFIJO}/nada.jpg`)).rejects.toMatchObject({
        code: 'INVALID_UPLOAD',
      })
    })

    it('rechaza y borra lo subido si no es una imagen válida', async () => {
      const almacen = new ObjectStorageEnMemoria()
      almacen.simularSubida(`${PREFIJO}/x.jpg`, 'text/html', 10)
      const subida = new SubidaDeImagenes(almacen)

      await expect(subida.confirmar(PREFIJO, `${PREFIJO}/x.jpg`)).rejects.toMatchObject({
        code: 'INVALID_UPLOAD',
      })
      expect(almacen.borradas).toEqual([`${PREFIJO}/x.jpg`])
    })
  })
})

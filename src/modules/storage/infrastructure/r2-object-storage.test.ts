import { NoSuchKey } from '@aws-sdk/client-s3'

import { SubidaNoValidaError } from '../domain/imagen'
import { contentDispositionDe, R2ObjectStorage } from './r2-object-storage'

describe('contentDispositionDe', () => {
  it('codifica el nombre en UTF-8 como filename*', () => {
    expect(contentDispositionDe('Factura ñ.pdf')).toBe(
      "attachment; filename*=UTF-8''Factura%20%C3%B1.pdf",
    )
  })

  it("escapa también ' ( ) * (RFC 5987)", () => {
    expect(contentDispositionDe("a(1)'*.pdf")).toBe(
      "attachment; filename*=UTF-8''a%281%29%27%2A.pdf",
    )
  })
})

describe('R2ObjectStorage.copiar', () => {
  const crear = () =>
    new R2ObjectStorage({
      endpoint: 'http://localhost:9',
      accessKeyId: 'k',
      secretAccessKey: 's',
      bucket: 'b',
    })

  it('un origen inexistente (NoSuchKey) es SubidaNoValidaError, no un 500', async () => {
    const almacen = crear()
    // El cliente S3 es privado: se simula su `send` sin red.
    vi.spyOn(
      (almacen as unknown as { client: { send: () => Promise<unknown> } }).client,
      'send',
    ).mockRejectedValue(new NoSuchKey({ message: 'no existe', $metadata: {} }))

    await expect(almacen.copiar('uploads/a', 'invoices/a')).rejects.toBeInstanceOf(
      SubidaNoValidaError,
    )
  })

  it('cualquier otro fallo de R2 se propaga tal cual', async () => {
    const almacen = crear()
    const roto = new Error('R2 caído')
    vi.spyOn(
      (almacen as unknown as { client: { send: () => Promise<unknown> } }).client,
      'send',
    ).mockRejectedValue(roto)

    await expect(almacen.copiar('uploads/a', 'invoices/a')).rejects.toBe(roto)
  })
})

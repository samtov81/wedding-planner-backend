import { contentDispositionDe } from './r2-object-storage'

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

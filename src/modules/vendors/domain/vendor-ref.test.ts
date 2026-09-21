import { parseVendorRef, VendorRefAmbiguaError, VendorRefVaciaError } from './vendor-ref'

describe('parseVendorRef', () => {
  it('acepta una referencia al marketplace', () => {
    expect(parseVendorRef({ vendorProfileId: 'perfil-1' })).toEqual({
      kind: 'linked',
      vendorProfileId: 'perfil-1',
    })
  })

  it('acepta un proveedor externo con sus datos', () => {
    expect(
      parseVendorRef({ externalName: 'Flores Pepa', externalEmail: 'pepa@flores.es' }),
    ).toEqual({
      kind: 'external',
      name: 'Flores Pepa',
      email: 'pepa@flores.es',
      phone: null,
    })
  })

  it('rechaza traer ambos, antes de llegar al CHECK de Postgres', () => {
    expect(() =>
      parseVendorRef({ vendorProfileId: 'perfil-1', externalName: 'Flores Pepa' }),
    ).toThrow(VendorRefAmbiguaError)
  })

  it('rechaza no traer ninguno', () => {
    expect(() => parseVendorRef({})).toThrow(VendorRefVaciaError)
  })

  it('un nombre externo en blanco cuenta como ausente', () => {
    expect(() => parseVendorRef({ externalName: '   ' })).toThrow(VendorRefVaciaError)
  })

  // Ronda de arreglo 1, hallazgo Important #1 (C11): un email o teléfono
  // externo junto a una ficha del marketplace no puede tirarse en silencio
  // como pasaba antes — tiene que ser tan ambiguo como `externalName`.
  it('rechaza un email externo junto a una ficha del marketplace', () => {
    expect(() =>
      parseVendorRef({ vendorProfileId: 'perfil-1', externalEmail: 'pepa@flores.es' }),
    ).toThrow(VendorRefAmbiguaError)
  })

  it('rechaza un teléfono externo junto a una ficha del marketplace', () => {
    expect(() =>
      parseVendorRef({ vendorProfileId: 'perfil-1', externalPhone: '600111222' }),
    ).toThrow(VendorRefAmbiguaError)
  })

  it('rechaza email Y teléfono externos junto a una ficha del marketplace', () => {
    expect(() =>
      parseVendorRef({
        vendorProfileId: 'perfil-1',
        externalEmail: 'pepa@flores.es',
        externalPhone: '600111222',
      }),
    ).toThrow(VendorRefAmbiguaError)
  })

  it('un email/teléfono externo en blanco junto a una ficha SÍ es una referencia enlazada legítima', () => {
    expect(
      parseVendorRef({ vendorProfileId: 'perfil-1', externalEmail: '   ', externalPhone: '' }),
    ).toEqual({ kind: 'linked', vendorProfileId: 'perfil-1' })
  })
})

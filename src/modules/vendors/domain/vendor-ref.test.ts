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
})

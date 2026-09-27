import { VendorCatalogRepositoryEnMemoria } from '../infrastructure/vendor-catalog.repository.fake'
import { SearchVendorCatalogUseCase } from './search-vendor-catalog.use-case'

describe('SearchVendorCatalogUseCase', () => {
  it('solo devuelve los perfiles publicados', async () => {
    const catalogo = new VendorCatalogRepositoryEnMemoria()
    const caso = new SearchVendorCatalogUseCase(catalogo)

    catalogo.perfiles.push(
      {
        id: '11111111-1111-4111-8111-111111111111',
        businessName: 'Lumière Catering',
        category: { slug: 'catering', name: 'Catering' },
        specialty: null,
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        status: 'PUBLISHED',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        businessName: 'Foto Luz',
        category: { slug: 'photography', name: 'Photography' },
        specialty: null,
        createdAt: new Date('2026-03-01T00:01:00.000Z'),
        status: 'PUBLISHED',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        businessName: 'Oculto',
        category: { slug: 'catering', name: 'Catering' },
        specialty: null,
        createdAt: new Date('2026-03-01T00:02:00.000Z'),
        status: 'DRAFT',
      },
    )

    const pagina = await caso.ejecutar({ q: null, category: null, cursor: null, limit: 20 })

    expect(pagina.items.map((p) => p.businessName)).toEqual(['Lumière Catering', 'Foto Luz'])
    expect(pagina.nextCursor).toBeNull()
  })
})

import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import {
  type PerfilEnMemoria,
  VendorCatalogRepositoryEnMemoria,
} from '../infrastructure/vendor-catalog.repository.fake'
import { SearchVendorCatalogUseCase } from './search-vendor-catalog.use-case'

/** Un despliegue sin R2: lo guardado sale sin URL (como `SinAlmacenamiento`). */
class SinFirmaDeLectura extends ObjectStorageEnMemoria {
  override firmarLectura(): Promise<string | null> {
    return Promise.resolve(null)
  }
}

const BASE = Date.parse('2026-03-01T00:00:00.000Z')
const SIN_FILTROS = { q: null, category: null, cursor: null, limit: 20 }

/** `perfil(1)` → id `11111111-1111-4111-8111-111111111111`, creado un minuto tras BASE. */
function perfil(n: number, datos: Partial<PerfilEnMemoria> = {}): PerfilEnMemoria {
  const d = String(n)
  return {
    id: `${d.repeat(8)}-${d.repeat(4)}-4${d.repeat(3)}-8${d.repeat(3)}-${d.repeat(12)}`,
    businessName: `Proveedor ${n}`,
    category: { slug: 'catering', name: 'Catering' },
    specialty: null,
    currency: 'USD',
    createdAt: new Date(BASE + n * 60_000),
    status: 'PUBLISHED',
    precios: [],
    fotos: [],
    ...datos,
  }
}

function montar(storage: ObjectStorageEnMemoria = new ObjectStorageEnMemoria()) {
  const catalogo = new VendorCatalogRepositoryEnMemoria()
  const caso = new SearchVendorCatalogUseCase(catalogo, new SubidaDeImagenes(storage))
  return { catalogo, caso }
}

describe('SearchVendorCatalogUseCase', () => {
  it('solo devuelve los perfiles publicados', async () => {
    const { catalogo, caso } = montar()
    catalogo.perfiles.push(
      perfil(1, { businessName: 'Lumière Catering' }),
      perfil(2, {
        businessName: 'Foto Luz',
        category: { slug: 'photography', name: 'Photography' },
      }),
      perfil(3, { businessName: 'Oculto', status: 'DRAFT' }),
    )

    const pagina = await caso.ejecutar(SIN_FILTROS)

    expect(pagina.items.map((p) => p.businessName)).toEqual(['Lumière Catering', 'Foto Luz'])
    expect(pagina.nextCursor).toBeNull()
  })

  it('firma la key de la primera foto y devuelve la vista sin imageKey ni createdAt', async () => {
    const { catalogo, caso } = montar()
    catalogo.perfiles.push(
      perfil(1, {
        businessName: 'Lumière Catering',
        currency: 'EUR',
        precios: ['10000.00', '9000.00', '4500.50'],
        fotos: [
          { id: 'b', storageKey: 'users/u1/portfolio/segunda.jpg', position: 1 },
          { id: 'a', storageKey: 'users/u1/portfolio/primera.jpg', position: 0 },
        ],
      }),
    )

    const { items } = await caso.ejecutar(SIN_FILTROS)

    expect(items).toEqual([
      {
        id: '11111111-1111-4111-8111-111111111111',
        businessName: 'Lumière Catering',
        category: { slug: 'catering', name: 'Catering' },
        specialty: null,
        currency: 'EUR',
        priceFrom: '4500.50',
        imageUrl: 'https://almacen.test/get/users/u1/portfolio/primera.jpg',
      },
    ])
  })

  it('sin paquetes ni fotos → priceFrom e imageUrl a null; currency pasa tal cual', async () => {
    const { catalogo, caso } = montar()
    catalogo.perfiles.push(perfil(1, { currency: 'MXN' }))

    const [item] = (await caso.ejecutar(SIN_FILTROS)).items

    expect(item).toMatchObject({ currency: 'MXN', priceFrom: null, imageUrl: null })
  })

  it('sin almacenamiento, una ficha con fotos sale con imageUrl null sin fallar', async () => {
    const { catalogo, caso } = montar(new SinFirmaDeLectura())
    catalogo.perfiles.push(
      perfil(1, { fotos: [{ id: 'a', storageKey: 'users/u1/portfolio/a.jpg', position: 0 }] }),
    )

    const [item] = (await caso.ejecutar(SIN_FILTROS)).items

    expect(item?.imageUrl).toBeNull()
  })

  it('conserva el orden de los ítems y el cursor de la página', async () => {
    const { catalogo, caso } = montar()
    catalogo.perfiles.push(
      perfil(1, { fotos: [{ id: 'a', storageKey: 'users/u1/portfolio/a.jpg', position: 0 }] }),
      perfil(2),
      perfil(3, { fotos: [{ id: 'c', storageKey: 'users/u3/portfolio/c.jpg', position: 0 }] }),
    )

    const p1 = await caso.ejecutar({ ...SIN_FILTROS, limit: 2 })

    expect(p1.items.map((p) => p.imageUrl)).toEqual([
      'https://almacen.test/get/users/u1/portfolio/a.jpg',
      null,
    ])
    expect(p1.nextCursor).not.toBeNull()
  })
})

import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import type { DatosDeFicha } from '../domain/vendor-profile'
import { VendorProfileRepositoryEnMemoria } from '../infrastructure/vendor-profile.repository.fake'
import { GetPublicVendorProfileUseCase } from './get-public-vendor-profile.use-case'
import {
  GetMyVendorProfileUseCase,
  ReplacePackagesUseCase,
  SaveMyVendorProfileUseCase,
  SetVendorModeUseCase,
} from './my-vendor-profile.use-cases'
import {
  AddPortfolioImageUseCase,
  PreparePortfolioUploadUseCase,
  RemovePortfolioImageUseCase,
  ReorderPortfolioUseCase,
  UpdatePortfolioImageUseCase,
} from './portfolio.use-cases'

const USER = '11111111-1111-4111-8111-111111111111'

function datos(cambios: Partial<DatosDeFicha> = {}): DatosDeFicha {
  return {
    businessName: 'Aurelia Luxe',
    category: 'Photography',
    specialty: null,
    tagline: null,
    bio: null,
    quote: null,
    yearsExperience: null,
    responseTime: null,
    currency: 'USD',
    publications: [],
    contact: { email: null, phone: null, website: null },
    location: null,
    ...cambios,
  }
}

function montar() {
  const repo = new VendorProfileRepositoryEnMemoria()
  const almacen = new ObjectStorageEnMemoria()
  const imagenes = new SubidaDeImagenes(almacen)
  const udt = new UnidadDeTrabajoEnMemoria()
  const leer = new GetMyVendorProfileUseCase(repo, imagenes)
  return {
    repo,
    almacen,
    leer,
    guardar: new SaveMyVendorProfileUseCase(repo, leer),
    modo: new SetVendorModeUseCase(repo, leer),
    paquetes: new ReplacePackagesUseCase(repo, udt, leer),
    preparar: new PreparePortfolioUploadUseCase(leer, imagenes),
    agregar: new AddPortfolioImageUseCase(repo, udt, imagenes, leer),
    editarFoto: new UpdatePortfolioImageUseCase(repo, leer),
    borrarFoto: new RemovePortfolioImageUseCase(repo, imagenes, leer),
    reordenar: new ReorderPortfolioUseCase(repo, udt, leer),
    publica: new GetPublicVendorProfileUseCase(repo, imagenes),
  }
}

describe('Ficha de proveedor', () => {
  it('sin ficha, el modo proveedor está apagado: 404', async () => {
    const { leer } = montar()

    await expect(leer.ejecutar(USER)).rejects.toMatchObject({ code: 'VENDOR_PROFILE_NOT_FOUND' })
  })

  it('guardar crea la ficha en DRAFT: el switch sigue apagado', async () => {
    const { guardar } = montar()

    const ficha = await guardar.ejecutar(USER, datos())

    expect(ficha.status).toBe('DRAFT')
    expect(ficha.priceFrom).toBeNull()
    expect(ficha.weddingsCount).toBe(0)
  })

  it('el switch publica y oculta sin perder datos', async () => {
    const { guardar, modo } = montar()
    await guardar.ejecutar(USER, datos({ tagline: 'Luxury' }))

    expect((await modo.ejecutar(USER, true)).status).toBe('PUBLISHED')
    const oculta = await modo.ejecutar(USER, false)
    expect(oculta.status).toBe('DRAFT')
    expect(oculta.tagline).toBe('Luxury')
  })

  it('encender el switch sin ficha es 404', async () => {
    const { modo } = montar()

    await expect(modo.ejecutar(USER, true)).rejects.toMatchObject({ httpStatus: 404 })
  })

  it('una ficha suspendida no se mueve con el switch', async () => {
    const { repo, modo } = montar()
    repo.sembrar(USER, datos(), 'SUSPENDED')

    await expect(modo.ejecutar(USER, true)).rejects.toMatchObject({
      code: 'VENDOR_PROFILE_SUSPENDED',
    })
  })

  it('editar los datos no cambia el estado', async () => {
    const { guardar, modo } = montar()
    await guardar.ejecutar(USER, datos())
    await modo.ejecutar(USER, true)

    expect((await guardar.ejecutar(USER, datos({ businessName: 'Otra' }))).status).toBe('PUBLISHED')
  })

  it('los paquetes se reemplazan en orden y fijan "Pricing From"', async () => {
    const { guardar, paquetes } = montar()
    await guardar.ejecutar(USER, datos())

    const ficha = await paquetes.ejecutar(USER, [
      { name: 'Signature', description: 'Todo el día', price: '7200.00' },
      { name: 'Essentials', description: '6 horas', price: '4500.00' },
    ])

    expect(ficha.packages.map((p) => p.name)).toEqual(['Signature', 'Essentials'])
    expect(ficha.priceFrom).toBe('4500.00')
    expect((await paquetes.ejecutar(USER, [])).packages).toEqual([])
  })

  describe('portfolio', () => {
    async function conFotos(n: number) {
      const m = montar()
      await m.guardar.ejecutar(USER, datos())
      for (let i = 0; i < n; i++) {
        const { key } = await m.preparar.ejecutar(USER, { contentType: 'image/jpeg', size: 100 })
        m.almacen.simularSubida(key)
        await m.agregar.ejecutar(USER, { key, alt: `Foto ${i}` })
      }
      return m
    }

    it('sube, describe, reordena y borra fotos', async () => {
      const m = await conFotos(3)
      let ficha = await m.leer.ejecutar(USER)
      const [a, b, c] = ficha.portfolio.map((f) => f.id)
      expect(ficha.portfolio.every((f) => f.url !== null)).toBe(true)

      ficha = await m.editarFoto.ejecutar(USER, a ?? '', { alt: 'Ceremonia' })
      expect(ficha.portfolio[0]?.alt).toBe('Ceremonia')

      ficha = await m.reordenar.ejecutar(USER, [c ?? '', a ?? '', b ?? ''])
      expect(ficha.portfolio.map((f) => f.id)).toEqual([c, a, b])

      await m.borrarFoto.ejecutar(USER, a ?? '')
      expect((await m.leer.ejecutar(USER)).portfolio.map((f) => f.id)).toEqual([c, b])
      expect(m.almacen.borradas).toHaveLength(1)
    })

    it('no pasa de 20 fotos: ni se firma la subida 21', async () => {
      const m = await conFotos(20)

      await expect(
        m.preparar.ejecutar(USER, { contentType: 'image/jpeg', size: 100 }),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_LIMIT_EXCEEDED' })
    })

    it('un orden que no es exactamente el conjunto actual se rechaza', async () => {
      const m = await conFotos(2)
      const [a] = (await m.leer.ejecutar(USER)).portfolio.map((f) => f.id)

      await expect(m.reordenar.ejecutar(USER, [a ?? '', a ?? ''])).rejects.toMatchObject({
        code: 'PORTFOLIO_ORDER_INVALID',
      })
    })

    it('borrar o editar una foto ajena es 404', async () => {
      const m = await conFotos(1)

      await expect(
        m.borrarFoto.ejecutar(USER, '00000000-0000-4000-8000-000000000000'),
      ).rejects.toMatchObject({ code: 'PORTFOLIO_IMAGE_NOT_FOUND' })
    })
  })

  describe('ficha pública', () => {
    it('sólo existe si está publicada', async () => {
      const { guardar, modo, publica } = montar()
      const { id } = await guardar.ejecutar(USER, datos())

      await expect(publica.ejecutar(id)).rejects.toMatchObject({ httpStatus: 404 })
      await modo.ejecutar(USER, true)
      expect((await publica.ejecutar(id)).businessName).toBe('Aurelia Luxe')
    })

    it('no expone el estado y trae bodas reales y similares de la misma categoría', async () => {
      const { repo, publica } = montar()
      const propia = repo.sembrar(USER, datos(), 'PUBLISHED')
      repo.sembrar('u2', datos({ businessName: 'Maison', category: 'photography' }), 'PUBLISHED')
      repo.sembrar('u3', datos({ businessName: 'Oculta' }), 'DRAFT')
      repo.sembrar('u4', datos({ businessName: 'Flores', category: 'Floral' }), 'PUBLISHED')
      repo.sembrarBoda(propia.id, 'e1')
      repo.sembrarBoda(propia.id, 'e2')

      const ficha = await publica.ejecutar(propia.id)

      expect(ficha).not.toHaveProperty('status')
      expect(ficha.weddingsCount).toBe(2)
      expect(ficha.similar.map((s) => s.businessName)).toEqual(['Maison'])
    })

    it('la foto de la ficha es el avatar del dueño', async () => {
      const { repo, publica } = montar()
      const ficha = repo.sembrar(USER, datos(), 'PUBLISHED')
      expect((await publica.ejecutar(ficha.id)).avatarUrl).toBeNull()

      repo.sembrarAvatar(USER, `users/${USER}/avatar/a.jpg`)
      expect((await publica.ejecutar(ficha.id)).avatarUrl).toContain('/avatar/a.jpg')
    })
  })
})

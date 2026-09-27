import { SubidaDeImagenes } from '@/modules/storage/application/subida-de-imagenes'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import { UserRepositoryEnMemoria } from '../infrastructure/user.repository.fake'
import {
  PrepareAvatarUploadUseCase,
  RemoveAvatarUseCase,
  SetAvatarUseCase,
} from './avatar.use-cases'
import { GetMyProfileUseCase } from './get-my-profile.use-case'
import { UpdateMyProfileUseCase } from './update-my-profile.use-case'

async function montar() {
  const usuarios = new UserRepositoryEnMemoria()
  const almacen = new ObjectStorageEnMemoria()
  const imagenes = new SubidaDeImagenes(almacen)
  const leer = new GetMyProfileUseCase(usuarios, imagenes)
  const ana = await usuarios.create({ email: 'ana@test.com', passwordHash: 'h', fullName: 'Ana' })
  return {
    ana,
    almacen,
    leer,
    actualizar: new UpdateMyProfileUseCase(usuarios, leer),
    preparar: new PrepareAvatarUploadUseCase(imagenes),
    fijar: new SetAvatarUseCase(usuarios, imagenes, leer),
    quitar: new RemoveAvatarUseCase(usuarios, imagenes),
  }
}

describe('Perfil personal', () => {
  it('un usuario recién registrado tiene perfil sin avatar', async () => {
    const { ana, leer } = await montar()

    expect(await leer.ejecutar(ana.id)).toEqual({
      id: ana.id,
      email: 'ana@test.com',
      fullName: 'Ana',
      avatarUrl: null,
    })
  })

  it('un usuario inexistente es 404', async () => {
    const { leer } = await montar()

    await expect(leer.ejecutar('00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({
      httpStatus: 404,
    })
  })

  it('cambia el nombre', async () => {
    const { ana, actualizar } = await montar()

    expect((await actualizar.ejecutar(ana.id, { fullName: 'Ana María' })).fullName).toBe(
      'Ana María',
    )
  })

  it('sube un avatar, lo reemplaza borrando el anterior y lo quita', async () => {
    const { ana, almacen, preparar, fijar, quitar, leer } = await montar()

    const primera = await preparar.ejecutar(ana.id, { contentType: 'image/png', size: 500 })
    expect(primera.key.startsWith(`users/${ana.id}/avatar/`)).toBe(true)
    almacen.simularSubida(primera.key, 'image/png', 500)
    expect((await fijar.ejecutar(ana.id, primera.key)).avatarUrl).toContain(primera.key)

    const segunda = await preparar.ejecutar(ana.id, { contentType: 'image/jpeg', size: 800 })
    almacen.simularSubida(segunda.key, 'image/jpeg', 800)
    await fijar.ejecutar(ana.id, segunda.key)
    expect(almacen.borradas).toEqual([primera.key])

    await quitar.ejecutar(ana.id)
    expect(almacen.borradas).toEqual([primera.key, segunda.key])
    expect((await leer.ejecutar(ana.id)).avatarUrl).toBeNull()
  })

  it('no acepta como avatar la foto de otro usuario', async () => {
    const { ana, almacen, fijar } = await montar()
    almacen.simularSubida('users/otro/avatar/x.jpg')

    await expect(fijar.ejecutar(ana.id, 'users/otro/avatar/x.jpg')).rejects.toMatchObject({
      code: 'INVALID_UPLOAD',
    })
  })
})

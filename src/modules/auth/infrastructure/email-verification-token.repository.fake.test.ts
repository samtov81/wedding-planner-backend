import { EmailVerificationTokenRepositoryFake } from './email-verification-token.repository.fake'

/**
 * El doble es lo que usan `register.use-case.test.ts` y
 * `verify-email.use-case.test.ts`; si fuera más permisivo que Postgres, esos
 * verdes no significarían nada. Aquí se fija su contrato; la paridad con el
 * adaptador real vive en `.paridad.test.ts` (ruling H1).
 */
describe('EmailVerificationTokenRepositoryFake', () => {
  const AHORA = new Date('2026-03-01T10:00:00.000Z')
  const MAÑANA = new Date('2026-03-02T10:00:00.000Z')
  let repo: EmailVerificationTokenRepositoryFake

  beforeEach(() => {
    repo = new EmailVerificationTokenRepositoryFake()
  })

  it('un token recién creado se consume una vez y devuelve su userId', async () => {
    await repo.crear({ userId: 'u-1', tokenHash: 'hash-1', expiresAt: MAÑANA })

    expect(await repo.consumirPorHash('hash-1', AHORA)).toEqual({
      resultado: 'CONSUMIDO',
      userId: 'u-1',
    })
  })

  it('el segundo intento dice YA_CONSUMIDO, no "no existe": es lo que distingue el mensaje amable del error', async () => {
    await repo.crear({ userId: 'u-1', tokenHash: 'hash-1', expiresAt: MAÑANA })
    await repo.consumirPorHash('hash-1', AHORA)

    // Un segundo clic en el enlace del correo (o el prefetch del cliente de
    // correo) NO puede acabar en "token inválido": el usuario ya está verificado.
    expect((await repo.consumirPorHash('hash-1', AHORA)).resultado).toBe('YA_CONSUMIDO')
  })

  it('un hash que nunca existió es NO_ENCONTRADO_O_CADUCADO y no filtra userId', async () => {
    const resultado = await repo.consumirPorHash('hash-inventado', AHORA)

    expect(resultado.resultado).toBe('NO_ENCONTRADO_O_CADUCADO')
    expect(resultado.userId).toBeUndefined()
  })

  it('un token caducado no se consume, y caducado se confunde a propósito con inexistente', async () => {
    await repo.crear({ userId: 'u-1', tokenHash: 'hash-1', expiresAt: AHORA })

    // `expiresAt <= ahora` ya está fuera: el borde es exclusivo, igual que el
    // `expiresAt > $ahora` del adaptador Prisma.
    expect((await repo.consumirPorHash('hash-1', AHORA)).resultado).toBe(
      'NO_ENCONTRADO_O_CADUCADO',
    )
    expect(repo.obtenerPorHash('hash-1')?.status).toBe('PENDING')
  })

  it('consumir marca consumedAt con el instante que se le pasa, no con el reloj real', async () => {
    await repo.crear({ userId: 'u-1', tokenHash: 'hash-1', expiresAt: MAÑANA })
    await repo.consumirPorHash('hash-1', AHORA)

    expect(repo.obtenerPorHash('hash-1')?.consumedAt).toEqual(AHORA)
  })

  it('caducarVigentesDe sólo toca los vigentes de ESE usuario', async () => {
    await repo.crear({ userId: 'u-1', tokenHash: 'mio-vigente', expiresAt: MAÑANA })
    await repo.crear({ userId: 'u-2', tokenHash: 'ajeno-vigente', expiresAt: MAÑANA })

    await repo.caducarVigentesDe('u-1', AHORA)

    expect((await repo.consumirPorHash('mio-vigente', AHORA)).resultado).toBe(
      'NO_ENCONTRADO_O_CADUCADO',
    )
    // Invalidar los tokens de una cuenta no puede tumbar los de otra.
    expect((await repo.consumirPorHash('ajeno-vigente', AHORA)).resultado).toBe('CONSUMIDO')
  })

  it('caducarVigentesDe no resucita ni reescribe uno ya consumido', async () => {
    await repo.crear({ userId: 'u-1', tokenHash: 'hash-1', expiresAt: MAÑANA })
    await repo.consumirPorHash('hash-1', AHORA)

    await repo.caducarVigentesDe('u-1', AHORA)

    expect((await repo.consumirPorHash('hash-1', AHORA)).resultado).toBe('YA_CONSUMIDO')
  })

  it('el mismo hash dos veces revienta: en Postgres `tokenHash` es UNIQUE', async () => {
    await repo.crear({ userId: 'u-1', tokenHash: 'hash-1', expiresAt: MAÑANA })

    await expect(
      repo.crear({ userId: 'u-1', tokenHash: 'hash-1', expiresAt: MAÑANA }),
    ).rejects.toThrow()
  })

  it('cada token creado recibe un id propio', async () => {
    const uno = await repo.crear({ userId: 'u-1', tokenHash: 'a', expiresAt: MAÑANA })
    const dos = await repo.crear({ userId: 'u-1', tokenHash: 'b', expiresAt: MAÑANA })

    expect(uno.id).not.toBe(dos.id)
  })
})

import type { DomainError } from '@/shared/domain'

import { EmailDuplicadoError, ImportacionInvalidaError } from '../domain/guest-errors'
import { EVENTO_A, EVENTO_B, repoSembrado } from '../infrastructure/guests.fixture'
import { ImportGuestsUseCase, type FilaImportacion } from './import-guests.use-case'

function fila(
  name: string,
  email: string | null,
  extra: { companionsAllowed?: number; group?: string } = {},
): FilaImportacion {
  return {
    ok: true,
    datos: {
      name,
      email,
      group: extra.group ?? 'Family',
      dietary: null,
      companionsAllowed: extra.companionsAllowed ?? 0,
    },
  }
}

async function capturar(accion: () => Promise<unknown>): Promise<DomainError> {
  try {
    await accion()
  } catch (error) {
    return error as DomainError
  }
  throw new Error('se esperaba que la acción lanzara')
}

describe('ImportGuestsUseCase', () => {
  it('crea todas las filas válidas, con sus acompañantes, y dice cuántas', async () => {
    const repo = repoSembrado()
    const antes = repo.filas.length

    const resultado = await new ImportGuestsUseCase(repo).ejecutar(EVENTO_A, [
      fila('Tía Carmen', 'carmen@boda.test', { companionsAllowed: 2 }),
      fila('Abuelo Luis', null),
    ])

    expect(resultado).toEqual({ created: 2 })
    expect(repo.filas).toHaveLength(antes + 2)
    const carmen = repo.filas.find((g) => g.email === 'carmen@boda.test')
    expect(carmen).toMatchObject({
      eventId: EVENTO_A,
      companionsAllowed: 2,
      companionsConfirmed: null,
      rsvp: 'PENDING',
    })
  })

  it('varios invitados sin correo no chocan entre sí', async () => {
    const repo = repoSembrado()

    await expect(
      new ImportGuestsUseCase(repo).ejecutar(EVENTO_A, [fila('A', null), fila('B', null)]),
    ).resolves.toEqual({ created: 2 })
  })

  it('reporta TODAS las filas con problema, ordenadas, y no crea ninguna', async () => {
    const repo = repoSembrado()
    const antes = repo.filas.length

    const error = await capturar(() =>
      new ImportGuestsUseCase(repo).ejecutar(EVENTO_A, [
        fila('Nueva', 'nueva@boda.test'),
        { ok: false, fallos: [{ field: 'name', message: 'Too small' }] },
        fila('Repetida', 'NUEVA@boda.test'),
        fila('Ya invitada', 'G00@boda.test'),
      ]),
    )

    expect(error).toBeInstanceOf(ImportacionInvalidaError)
    expect(error.httpStatus).toBe(422)
    expect(error.code).toBe('GUEST_IMPORT_INVALID')
    expect(error.details).toEqual([
      { row: 2, field: 'name', code: 'INVALID', message: 'Too small' },
      {
        row: 3,
        field: 'email',
        code: 'DUPLICATED_IN_FILE',
        message: 'El correo ya aparece en la fila 1',
      },
      {
        row: 4,
        field: 'email',
        code: 'ALREADY_INVITED',
        message: 'Ya hay un invitado con ese correo en este evento',
      },
    ])
    expect(repo.filas).toHaveLength(antes)
  })

  it('un correo invitado a OTRO evento no cuenta como ya invitado', async () => {
    const repo = repoSembrado()

    // g00@boda.test es de EVENTO_A; en EVENTO_B está libre.
    await expect(
      new ImportGuestsUseCase(repo).ejecutar(EVENTO_B, [fila('Otra boda', 'g00@boda.test')]),
    ).resolves.toEqual({ created: 1 })
  })

  it('si el índice único salta en la escritura (carrera), es 409 y no crea nada', async () => {
    const repo = repoSembrado()
    // Simula que alguien creó el mismo correo entre la validación y la escritura.
    repo.emailsExistentes = () => Promise.resolve(new Set())
    const antes = repo.filas.length

    await expect(
      new ImportGuestsUseCase(repo).ejecutar(EVENTO_A, [
        fila('Libre', 'libre@boda.test'),
        fila('Carrera', 'g00@boda.test'),
      ]),
    ).rejects.toBeInstanceOf(EmailDuplicadoError)
    expect(repo.filas).toHaveLength(antes)
  })
})

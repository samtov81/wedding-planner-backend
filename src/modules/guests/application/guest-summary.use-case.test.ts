import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { GuestSummaryUseCase } from './guest-summary.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const EVENTO_VACIO = '22222222-2222-4222-8222-222222222222'

/**
 * 3 confirmados (con 2, 1 y 0 acompañantes), 2 pendientes, 1 rechazado. El
 * pendiente g3 tiene cupo 2 pero aún no confirmó: no debe contar.
 */
function repoSembrado(): GuestRepositoryEnMemoria {
  const repo = new GuestRepositoryEnMemoria()
  const filas = [
    ['CONFIRMED', 2],
    ['CONFIRMED', 1],
    ['CONFIRMED', 0],
    ['PENDING', null],
    ['PENDING', null],
    ['DECLINED', 0],
  ] as const

  filas.forEach(([rsvp, companionsConfirmed], i) => {
    repo.sembrar({
      id: `g${i}`,
      eventId: EVENTO,
      name: `G0${i}`,
      email: null,
      group: 'Family',
      rsvp,
      dietary: null,
      companionsAllowed: 2,
      companionsConfirmed,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    })
  })

  return repo
}

describe('GuestSummaryUseCase', () => {
  it('deriva los contadores de las filas, sin columna de contador', async () => {
    const caso = new GuestSummaryUseCase(repoSembrado())

    const resumen = await caso.ejecutar(EVENTO)

    expect(resumen).toEqual({ total: 6, confirmed: 3, pending: 2, declined: 1, attending: 6 })
  })

  it('attending = confirmados + sus acompañantes confirmados, nada de pendientes', async () => {
    const repo = repoSembrado()
    // Un DECLINED con acompañantes (dato imposible por el caso de uso, pero
    // posible en la tabla) tampoco suma: sólo cuentan los CONFIRMED.
    const rechazado = repo.filas.find((g) => g.rsvp === 'DECLINED')
    if (rechazado !== undefined) rechazado.companionsConfirmed = 2

    const r = await new GuestSummaryUseCase(repo).ejecutar(EVENTO)

    expect(r.attending).toBe(6)
  })

  it('el total siempre cuadra con la suma de los estados', async () => {
    const caso = new GuestSummaryUseCase(repoSembrado())

    const r = await caso.ejecutar(EVENTO)

    expect(r.confirmed + r.pending + r.declined).toBe(r.total)
  })

  it('devuelve ceros, no undefined, para un evento sin invitados', async () => {
    const caso = new GuestSummaryUseCase(repoSembrado())

    await expect(caso.ejecutar(EVENTO_VACIO)).resolves.toEqual({
      total: 0,
      confirmed: 0,
      pending: 0,
      declined: 0,
      attending: 0,
    })
  })
})

import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { GuestSummaryUseCase } from './guest-summary.use-case'

const EVENTO = '11111111-1111-4111-8111-111111111111'
const EVENTO_VACIO = '22222222-2222-4222-8222-222222222222'

/** 3 confirmados, 2 pendientes, 1 rechazado. */
function repoSembrado(): GuestRepositoryEnMemoria {
  const repo = new GuestRepositoryEnMemoria()
  const estados = ['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'PENDING', 'PENDING', 'DECLINED'] as const

  estados.forEach((rsvp, i) => {
    repo.sembrar({
      id: `g${i}`,
      eventId: EVENTO,
      name: `G0${i}`,
      email: null,
      group: 'Family',
      rsvp,
      dietary: null,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    })
  })

  return repo
}

describe('GuestSummaryUseCase', () => {
  it('deriva los contadores de las filas, sin columna de contador', async () => {
    const caso = new GuestSummaryUseCase(repoSembrado())

    const resumen = await caso.ejecutar(EVENTO)

    expect(resumen).toEqual({ total: 6, confirmed: 3, pending: 2, declined: 1 })
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
    })
  })
})

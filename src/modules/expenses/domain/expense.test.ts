import { calcularResumen, paidAtTrasCambio } from './expense'

describe('calcularResumen', () => {
  it('con total calcula sin asignar y lo que queda, admitiendo negativos', () => {
    expect(
      calcularResumen({
        currency: 'USD',
        totalBudget: '1000.00',
        assigned: '1200.00',
        paid: '300.10',
        pending: '800.00',
      }),
    ).toEqual({
      currency: 'USD',
      totalBudget: '1000.00',
      assigned: '1200.00',
      unassigned: '-200.00',
      paid: '300.10',
      pending: '800.00',
      remaining: '-100.10',
    })
  })

  it('sin total, sin asignar y lo que queda son null', () => {
    expect(
      calcularResumen({
        currency: 'EUR',
        totalBudget: null,
        assigned: '0.00',
        paid: '0.00',
        pending: '0.00',
      }),
    ).toMatchObject({ unassigned: null, remaining: null })
  })
})

describe('paidAtTrasCambio', () => {
  const ahora = new Date('2027-01-01T00:00:00Z')
  const antes = new Date('2026-12-01T00:00:00Z')
  it('PENDING → PAID fija ahora', () =>
    expect(paidAtTrasCambio({ status: 'PENDING', paidAt: null }, 'PAID', ahora)).toEqual(ahora))
  it('PAID → PAID conserva la fecha original', () =>
    expect(paidAtTrasCambio({ status: 'PAID', paidAt: antes }, 'PAID', ahora)).toEqual(antes))
  it('PAID → PENDING la borra', () =>
    expect(paidAtTrasCambio({ status: 'PAID', paidAt: antes }, 'PENDING', ahora)).toBeNull())
  it('sin cambio de estado conserva', () =>
    expect(paidAtTrasCambio({ status: 'PAID', paidAt: antes }, undefined, ahora)).toEqual(antes))
})

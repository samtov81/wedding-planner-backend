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
        porCategoria: [],
      }),
    ).toEqual({
      currency: 'USD',
      totalBudget: '1000.00',
      assigned: '1200.00',
      unassigned: '-200.00',
      paid: '300.10',
      pending: '800.00',
      remaining: '-100.10',
      byCategory: [],
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
        porCategoria: [],
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

describe('calcularResumen — byCategory', () => {
  const base = {
    currency: 'EUR',
    totalBudget: '1000.00',
    assigned: '0.00',
    paid: '0.00',
    pending: '0.00',
  }

  it('pliega pagado y pendiente por categoría, en céntimos, y ordena por total', () => {
    const r = calcularResumen({
      ...base,
      porCategoria: [
        { category: 'Flowers', status: 'PAID', amount: '100.10', count: 1 },
        { category: 'Flowers', status: 'PENDING', amount: '0.20', count: 2 },
        { category: 'Music', status: 'PENDING', amount: '500.00', count: 1 },
      ],
    })
    expect(r.byCategory).toEqual([
      { category: 'Music', paid: '0.00', pending: '500.00', total: '500.00', count: 1 },
      { category: 'Flowers', paid: '100.10', pending: '0.20', total: '100.30', count: 3 },
    ])
  })

  it('a igual total ordena por nombre', () => {
    const r = calcularResumen({
      ...base,
      porCategoria: [
        { category: 'B', status: 'PAID', amount: '10.00', count: 1 },
        { category: 'A', status: 'PAID', amount: '10.00', count: 1 },
      ],
    })
    expect(r.byCategory.map((c) => c.category)).toEqual(['A', 'B'])
  })

  it('sin gastos, byCategory vacío', () => {
    expect(calcularResumen({ ...base, porCategoria: [] }).byCategory).toEqual([])
  })
})

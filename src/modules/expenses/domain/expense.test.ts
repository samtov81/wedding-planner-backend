import {
  calcularResumen,
  estaVencido,
  hoyEnZona,
  impuestoDe,
  pasaAPagado,
  paidAtTrasCambio,
  subtotalValido,
} from './expense'

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

describe('factura', () => {
  describe('impuestoDe', () => {
    it('es amount menos subtotal', () => expect(impuestoDe('121.00', '100.00')).toBe('21.00'))
    it('sin impuestos es 0.00', () => expect(impuestoDe('100.00', '100.00')).toBe('0.00'))
    it('sin subtotal es null', () => expect(impuestoDe('100.00', null)).toBeNull())
  })

  describe('subtotalValido', () => {
    it('igual al importe es válido', () => expect(subtotalValido('100.00', '100.00')).toBe(true))
    it('mayor que el importe no es válido', () =>
      expect(subtotalValido('100.00', '100.01')).toBe(false))
    it('cero no es válido', () => expect(subtotalValido('100.00', '0.00')).toBe(false))
    it('sin subtotal es válido', () => expect(subtotalValido('100.00', null)).toBe(true))
  })

  describe('hoyEnZona', () => {
    const instante = new Date('2026-11-11T03:00:00Z')
    it('usa la fecha local de la zona', () =>
      expect(hoyEnZona(instante, 'America/Caracas')).toBe('2026-11-10'))
    it('en UTC coincide con la fecha UTC', () =>
      expect(hoyEnZona(instante, 'UTC')).toBe('2026-11-11'))
  })

  describe('estaVencido', () => {
    const dueDate = new Date('2026-11-10T00:00:00Z')
    it('PENDING con fecha pasada está vencido', () =>
      expect(estaVencido({ status: 'PENDING', dueDate }, '2026-11-11')).toBe(true))
    it('vence hoy: no está vencido', () =>
      expect(estaVencido({ status: 'PENDING', dueDate }, '2026-11-10')).toBe(false))
    it('PAID con fecha pasada no está vencido', () =>
      expect(estaVencido({ status: 'PAID', dueDate }, '2026-11-11')).toBe(false))
    it('sin dueDate no está vencido', () =>
      expect(estaVencido({ status: 'PENDING', dueDate: null }, '2026-11-11')).toBe(false))
  })

  describe('pasaAPagado', () => {
    it('un alta PAID pasa a pagado', () => expect(pasaAPagado(null, 'PAID')).toBe(true))
    it('PENDING a PAID pasa a pagado', () => expect(pasaAPagado('PENDING', 'PAID')).toBe(true))
    it('PAID a PAID no es un paso', () => expect(pasaAPagado('PAID', 'PAID')).toBe(false))
    it('PAID a PENDING no es un paso', () => expect(pasaAPagado('PAID', 'PENDING')).toBe(false))
    it('un alta PENDING no es un paso', () => expect(pasaAPagado(null, 'PENDING')).toBe(false))
  })
})

import { createExpenseSchema, updateExpenseSchema } from './expenses.dto'

const base = { concept: 'Anticipo', category: 'Music', amount: 200 }

describe('createExpenseSchema', () => {
  it('externo con monto normalizado y origen construido', () => {
    expect(createExpenseSchema.parse({ ...base, payeeName: ' Imprenta ' })).toMatchObject({
      amount: '200.00',
      origen: { kind: 'external', payeeName: 'Imprenta' },
    })
  })

  it.each([
    [{ ...base }],
    [{ ...base, payeeName: 'X', eventVendorId: '33333333-3333-4333-8333-333333333333' }],
    [{ ...base, payeeName: 'X', amount: 0 }],
    [{ ...base, payeeName: 'X', amount: '12.345' }],
    [{ ...base, payeeName: 'X', dueDate: '2027-13-01' }],
    [{ ...base, eventVendorId: 'no-uuid' }],
  ])('rechaza %o', (entrada) => {
    expect(createExpenseSchema.safeParse(entrada).success).toBe(false)
  })
})

describe('updateExpenseSchema', () => {
  it('exige al menos un cambio y no acepta paidAt', () => {
    expect(updateExpenseSchema.safeParse({}).success).toBe(false)
    expect(updateExpenseSchema.safeParse({ paidAt: '2027-01-01' }).success).toBe(false)
  })

  it('cambiar a externo construye el origen', () => {
    expect(updateExpenseSchema.parse({ payeeName: 'Otro' })).toEqual({
      origen: { kind: 'external', payeeName: 'Otro' },
    })
  })
})

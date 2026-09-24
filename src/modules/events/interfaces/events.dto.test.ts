import { createEventSchema, updateEventSchema } from './events.dto'

describe('createEventSchema', () => {
  it('solo el nombre es obligatorio', () => {
    expect(createEventSchema.parse({ name: ' Boda ' })).toEqual({ name: 'Boda' })
  })

  it('normaliza el presupuesto y valida moneda y zona horaria', () => {
    const datos = createEventSchema.parse({
      name: 'Boda',
      totalBudget: 1500,
      currency: 'COP',
      timezone: 'America/Bogota',
      weddingDate: '2027-06-12',
    })
    expect(datos.totalBudget).toBe('1500.00')
    expect(datos.weddingDate).toEqual(new Date('2027-06-12T00:00:00.000Z'))
  })

  it.each([
    [{ name: '' }],
    [{ name: 'B', currency: 'XXX' }],
    [{ name: 'B', timezone: 'Mars/Olympus' }],
    [{ name: 'B', totalBudget: '1,500' }],
    [{ name: 'B', totalBudget: -1 }],
    [{ name: 'B', venue: { address: 'X', lat: 100, lng: 0 } }],
  ])('rechaza %o', (entrada) => {
    expect(createEventSchema.safeParse(entrada).success).toBe(false)
  })
})

describe('updateEventSchema', () => {
  it('exige al menos un cambio', () => {
    expect(updateEventSchema.safeParse({}).success).toBe(false)
  })

  it('acepta null para borrar venue, fecha y presupuesto', () => {
    expect(updateEventSchema.parse({ venue: null, weddingDate: null, totalBudget: null })).toEqual({
      venue: null,
      weddingDate: null,
      totalBudget: null,
    })
  })

  it('no acepta cambiar el estado por PATCH', () => {
    expect(updateEventSchema.safeParse({ status: 'ACTIVE' }).success).toBe(false)
  })
})

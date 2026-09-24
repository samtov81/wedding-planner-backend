import type { Event } from './event'
import { camposFaltantesParaPublicar, completitud } from './publicacion'

const VENUE = {
  name: 'Hacienda',
  address: 'Km 5 vía La Calera',
  lat: 4.7,
  lng: -73.9,
  mapboxId: null,
}

function evento(parcial: Partial<Event> = {}): Event {
  return {
    id: 'e1',
    name: 'Boda Ana y Luis',
    status: 'DRAFT',
    weddingDate: new Date('2027-06-12T00:00:00Z'),
    timezone: 'America/Bogota',
    currency: 'COP',
    totalBudget: '45000000.00',
    venue: VENUE,
    rsvpDeadlineDays: 14,
    ownerId: 'u1',
    conteos: { scheduleItems: 0, vendors: 0 },
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...parcial,
  }
}

describe('camposFaltantesParaPublicar', () => {
  it('un evento completo no tiene faltantes', () => {
    expect(camposFaltantesParaPublicar(evento())).toEqual([])
  })

  it('lista en orden fijo todo lo que falta', () => {
    expect(
      camposFaltantesParaPublicar(
        evento({ name: '  ', weddingDate: null, totalBudget: null, venue: null }),
      ),
    ).toEqual(['name', 'weddingDate', 'totalBudget', 'venue'])
  })

  it('presupuesto 0 cuenta como presente', () => {
    expect(camposFaltantesParaPublicar(evento({ totalBudget: '0.00' }))).toEqual([])
  })
})

describe('completitud', () => {
  it('borrador solo con nombre', () => {
    expect(completitud(evento({ weddingDate: null, totalBudget: null, venue: null }))).toEqual({
      general: 'parcial',
      venue: 'vacio',
      schedule: 'vacio',
      budget: 'vacio',
    })
  })

  it('todo completo', () => {
    expect(completitud(evento({ conteos: { scheduleItems: 3, vendors: 2 } }))).toEqual({
      general: 'completo',
      venue: 'completo',
      schedule: 'completo',
      budget: 'completo',
    })
  })

  it('presupuesto sin proveedores es parcial, y proveedores sin total también', () => {
    expect(completitud(evento()).budget).toBe('parcial')
    expect(
      completitud(evento({ totalBudget: null, conteos: { scheduleItems: 0, vendors: 1 } })).budget,
    ).toBe('parcial')
  })
})

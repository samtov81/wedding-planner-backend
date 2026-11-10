import { componerDocumento } from './pdf-cronograma'
import type { ItemConAsignaciones, NotaDeItem } from './schedule-item.repository'

const EVENTO = {
  name: 'Boda de Ana y Luis',
  weddingDate: new Date('2027-06-13T03:00:00Z'),
  timezone: 'America/Bogota',
}

function item(extra: Partial<ItemConAsignaciones> = {}): ItemConAsignaciones {
  return {
    id: 'item-1',
    eventId: 'evento-1',
    title: 'Ceremonia',
    description: null,
    startsAt: new Date('2027-06-12T21:00:00Z'),
    endsAt: null,
    location: null,
    status: 'PENDING',
    createdAt: new Date('2027-01-01T00:00:00Z'),
    updatedAt: new Date('2027-01-01T00:00:00Z'),
    vendors: [],
    ...extra,
  }
}

function nota(itemId: string, body: string): NotaDeItem {
  return {
    id: `nota-${body}`,
    itemId,
    body,
    createdAt: new Date('2027-01-02T00:00:00Z'),
    author: { id: 'u1', name: 'Marta', avatarKey: null },
  }
}

describe('componerDocumento', () => {
  it('con notas (planner) las incluye en su ítem y no en los demás', () => {
    const doc = componerDocumento(
      EVENTO,
      [item(), item({ id: 'item-2', title: 'Fiesta' })],
      new Map([['item-1', [nota('item-1', 'Llamar al DJ')]]]),
    )
    expect(doc.items[0]?.notas).toEqual(['Marta: Llamar al DJ'])
    expect(doc.items[1]?.notas).toEqual([])
  })

  it('con null (quien no es planner) ningún ítem trae notas', () => {
    const doc = componerDocumento(EVENTO, [item(), item({ id: 'item-2' })], null)
    expect(doc.items.every((i) => i.notas.length === 0)).toBe(true)
    expect(JSON.stringify(doc)).not.toContain('Marta')
  })

  it('formatea la hora en la zona del evento, con el fin si existe', () => {
    const doc = componerDocumento(
      EVENTO,
      [
        item({ endsAt: new Date('2027-06-12T22:30:00Z') }),
        item({ id: 'item-2', startsAt: new Date('2027-06-13T04:30:00Z') }),
      ],
      null,
    )
    expect(doc.items[0]?.hora).toBe('16:00–17:30')
    expect(doc.items[1]?.hora).toBe('23:30')
  })

  it('pone la fecha y el título del evento', () => {
    const doc = componerDocumento(EVENTO, [], null)
    expect(doc.titulo).toBe('Boda de Ana y Luis')
    expect(doc.fecha).toContain('June 12, 2027')
    expect(componerDocumento({ ...EVENTO, weddingDate: null }, [], null).fecha).toBe('')
  })

  it('marca con ✓ sólo a los proveedores confirmados', () => {
    const doc = componerDocumento(
      EVENTO,
      [
        item({
          vendors: [
            { eventVendorId: 'a', name: 'Banda Sol', categoryName: 'Música', confirmed: true },
            { eventVendorId: 'b', name: 'Fotos Mar', categoryName: 'Foto', confirmed: false },
          ],
        }),
      ],
      null,
    )
    expect(doc.items[0]?.proveedores).toEqual(['Banda Sol (Música) ✓', 'Fotos Mar (Foto)'])
  })

  it('compone el lugar con nombre y dirección, o sólo la dirección', () => {
    const base = { address: 'Calle 1', lat: 1, lng: 2, mapboxId: null }
    const doc = componerDocumento(
      EVENTO,
      [
        item({ location: { ...base, name: 'Iglesia' } }),
        item({ id: 'i2', location: { ...base, name: null } }),
      ],
      null,
    )
    expect(doc.items.map((i) => i.lugar)).toEqual(['Iglesia, Calle 1', 'Calle 1'])
  })
})

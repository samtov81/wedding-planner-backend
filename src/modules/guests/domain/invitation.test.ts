import { admiteLectura, admiteRespuesta, cierreRsvp, estadosQuePuedenAvanzarA } from './invitation'

describe('estadosQuePuedenAvanzarA', () => {
  it('a RESPONDED se llega desde cualquier otro estado', () => {
    expect(estadosQuePuedenAvanzarA('RESPONDED').sort()).toEqual(
      ['BOUNCED', 'COMPLAINED', 'DELIVERED', 'QUEUED', 'SENT'].sort(),
    )
  })

  it('a DELIVERED no se llega ni desde BOUNCED/COMPLAINED ni desde RESPONDED', () => {
    expect(estadosQuePuedenAvanzarA('DELIVERED').sort()).toEqual(['QUEUED', 'SENT'])
  })

  it('BOUNCED y COMPLAINED no se pisan entre sí, ni un estado a sí mismo', () => {
    expect(estadosQuePuedenAvanzarA('BOUNCED')).not.toContain('COMPLAINED')
    expect(estadosQuePuedenAvanzarA('COMPLAINED')).not.toContain('BOUNCED')
    expect(estadosQuePuedenAvanzarA('BOUNCED')).not.toContain('BOUNCED')
  })

  it('nada retrocede a QUEUED', () => {
    expect(estadosQuePuedenAvanzarA('QUEUED')).toEqual([])
  })
})

describe('plazo del RSVP', () => {
  const evento = { weddingDate: new Date('2027-06-20T00:00:00Z'), rsvpDeadlineDays: 14 }

  it('cierra rsvpDeadlineDays días antes de la boda', () => {
    expect(cierreRsvp(evento).toISOString()).toBe('2027-06-06T00:00:00.000Z')
  })

  it('con 0 días cierra el mismo día de la boda', () => {
    expect(cierreRsvp({ ...evento, rsvpDeadlineDays: 0 }).toISOString()).toBe(
      '2027-06-20T00:00:00.000Z',
    )
  })

  it('admite respuesta antes del cierre, también si ya respondió', () => {
    const inv = { expiresAt: new Date('2027-09-01T00:00:00Z') }
    expect(admiteRespuesta(inv, evento, new Date('2027-06-05T23:59:59Z'))).toBe(true)
  })

  it('no admite respuesta desde el cierre', () => {
    const inv = { expiresAt: new Date('2027-09-01T00:00:00Z') }
    expect(admiteRespuesta(inv, evento, new Date('2027-06-06T00:00:00Z'))).toBe(false)
  })

  it('no admite respuesta ni lectura con el token caducado', () => {
    const inv = { expiresAt: new Date('2027-01-01T00:00:00Z') }
    const ahora = new Date('2027-01-02T00:00:00Z')
    expect(admiteRespuesta(inv, evento, ahora)).toBe(false)
    expect(admiteLectura(inv, ahora)).toBe(false)
  })

  it('admite lectura tras el cierre mientras el token no caduque', () => {
    const inv = { expiresAt: new Date('2027-09-01T00:00:00Z') }
    expect(admiteLectura(inv, new Date('2027-06-10T00:00:00Z'))).toBe(true)
  })

  it('una invitación caducada justo a `ahora` (C18) no admite lectura', () => {
    // Es lo que hace efectivo el ruling C18: caducar pone `expiresAt = ahora`.
    const ahora = new Date('2027-01-02T00:00:00Z')
    expect(admiteLectura({ expiresAt: ahora }, ahora)).toBe(false)
  })
})

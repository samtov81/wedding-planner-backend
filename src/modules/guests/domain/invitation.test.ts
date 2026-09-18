import { admiteRespuesta, estadosQuePuedenAvanzarA } from './invitation'

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

describe('admiteRespuesta', () => {
  const ahora = new Date(Date.UTC(2026, 8, 18, 12))
  const mañana = new Date(ahora.getTime() + 86_400_000)

  it.each(['QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'COMPLAINED'] as const)(
    'una invitación %s y sin caducar admite respuesta',
    (status) => {
      expect(admiteRespuesta({ status, expiresAt: mañana }, ahora)).toBe(true)
    },
  )

  it('una invitación ya RESPONDED no admite otra: el token es de un solo uso', () => {
    expect(admiteRespuesta({ status: 'RESPONDED', expiresAt: mañana }, ahora)).toBe(false)
  })

  it('una invitación caducada no admite respuesta aunque su estado sí la admitiera', () => {
    // Es lo que hace efectivo el ruling C18: caducar pone `expiresAt = ahora`.
    expect(admiteRespuesta({ status: 'SENT', expiresAt: ahora }, ahora)).toBe(false)
    expect(
      admiteRespuesta({ status: 'SENT', expiresAt: new Date(ahora.getTime() - 1) }, ahora),
    ).toBe(false)
  })
})

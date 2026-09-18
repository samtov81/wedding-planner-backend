import { estadosQuePuedenAvanzarA } from './invitation'

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

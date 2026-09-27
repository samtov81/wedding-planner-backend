import { estadoAlCambiarModo, precioDesde, prefijoDePortfolio } from './vendor-profile'

describe('estadoAlCambiarModo', () => {
  it.each([
    ['DRAFT', true, 'PUBLISHED'],
    ['DRAFT', false, 'DRAFT'],
    ['PUBLISHED', false, 'DRAFT'],
    ['PUBLISHED', true, 'PUBLISHED'],
  ] as const)('%s con switch %s → %s', (actual, activo, esperado) => {
    expect(estadoAlCambiarModo(actual, activo)).toBe(esperado)
  })

  it('una ficha suspendida no la mueve su dueño', () => {
    expect(estadoAlCambiarModo('SUSPENDED', true)).toBeNull()
    expect(estadoAlCambiarModo('SUSPENDED', false)).toBeNull()
  })
})

describe('precioDesde', () => {
  it('es el paquete más barato comparando montos exactos, no como texto', () => {
    expect(precioDesde([{ price: '900.00' }, { price: '4500.00' }, { price: '10000.00' }])).toBe(
      '900.00',
    )
  })

  it('sin paquetes no hay precio', () => {
    expect(precioDesde([])).toBeNull()
  })
})

it('el portfolio vive bajo la carpeta del usuario', () => {
  expect(prefijoDePortfolio('u1')).toBe('users/u1/portfolio')
})

import {
  actualizarInvitadoSchema,
  crearInvitadoSchema,
  importarInvitadosSchema,
  validarFilaImportacion,
} from './guest.dto'

describe('crearInvitadoSchema · companionsAllowed', () => {
  const base = { name: 'Ana', group: 'Family' }

  it('ausente = 0', () => {
    expect(crearInvitadoSchema.parse(base).companionsAllowed).toBe(0)
  })

  it.each([0, 10])('acepta %i', (n) => {
    expect(crearInvitadoSchema.parse({ ...base, companionsAllowed: n }).companionsAllowed).toBe(n)
  })

  it.each([-1, 11, 1.5, '2'])('rechaza %j', (n) => {
    expect(crearInvitadoSchema.safeParse({ ...base, companionsAllowed: n }).success).toBe(false)
  })

  it('el email sigue siendo opcional, pero si viene tiene que ser un correo', () => {
    expect(crearInvitadoSchema.safeParse(base).success).toBe(true)
    expect(crearInvitadoSchema.safeParse({ ...base, email: 'no-es-correo' }).success).toBe(false)
  })
})

describe('actualizarInvitadoSchema · companionsAllowed', () => {
  it('ausente no se rellena con 0: en un PATCH significa "no lo toques"', () => {
    expect(actualizarInvitadoSchema.parse({ name: 'Ana' })).not.toHaveProperty('companionsAllowed')
  })

  it('sólo el cupo cuenta como cambio', () => {
    expect(actualizarInvitadoSchema.parse({ companionsAllowed: 3 })).toEqual({
      companionsAllowed: 3,
    })
  })
})

describe('importarInvitadosSchema', () => {
  it('exige entre 1 y 500 filas', () => {
    expect(importarInvitadosSchema.safeParse({ guests: [] }).success).toBe(false)
    expect(importarInvitadosSchema.safeParse({ guests: Array(500).fill({}) }).success).toBe(true)
    expect(importarInvitadosSchema.safeParse({ guests: Array(501).fill({}) }).success).toBe(false)
  })
})

describe('validarFilaImportacion', () => {
  it('normaliza una fila válida a los datos del dominio', () => {
    expect(
      validarFilaImportacion({ name: ' Ana ', group: 'Family', companionsAllowed: 1 }),
    ).toEqual({
      ok: true,
      datos: { name: 'Ana', email: null, group: 'Family', dietary: null, companionsAllowed: 1 },
    })
  })

  it('devuelve cada fallo con su campo, sin lanzar', () => {
    const resultado = validarFilaImportacion({ name: '', group: 'Family', companionsAllowed: 11 })

    expect(resultado.ok).toBe(false)
    if (resultado.ok) return
    expect(resultado.fallos.map((f) => f.field).sort()).toEqual(['companionsAllowed', 'name'])
  })

  it('una fila que no es objeto también es un fallo, no un 500', () => {
    const resultado = validarFilaImportacion('Ana,ana@x.com')

    expect(resultado).toMatchObject({ ok: false, fallos: [{ field: 'row' }] })
  })
})

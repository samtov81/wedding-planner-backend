import { describe, expect, it } from 'vitest'

import {
  MAX_NOTA,
  MAX_TITULO,
  exigirActiva,
  exigirCupo,
  normalizarNota,
  normalizarTitulo,
} from './moodboard'
import { ProveedorNoCompartibleError } from './moodboard-errors'

/**
 * Lo que lanza `fn`, o `undefined` si no lanza. `toThrow(expect.objectContaining(...))`
 * diría lo mismo, pero `objectContaining` es `any` y ESLint lo rechaza como argumento.
 */
function errorDe(fn: () => void): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('normalizarTitulo', () => {
  it('recorta los espacios de los extremos', () => {
    expect(normalizarTitulo('  Peonías ')).toBe('Peonías')
  })

  it.each(['', '   '])('rechaza un título vacío (%j)', (valor) => {
    expect(errorDe(() => normalizarTitulo(valor))).toMatchObject({ code: 'INVALID_TITLE' })
  })

  it('admite 120 caracteres y rechaza 121', () => {
    expect(normalizarTitulo('a'.repeat(MAX_TITULO))).toHaveLength(MAX_TITULO)
    expect(errorDe(() => normalizarTitulo('a'.repeat(MAX_TITULO + 1)))).toMatchObject({
      code: 'INVALID_TITLE',
      httpStatus: 422,
    })
  })

  it('mide tras el recorte: 120 útiles con espacios alrededor pasan', () => {
    expect(normalizarTitulo(` ${'a'.repeat(MAX_TITULO)} `)).toHaveLength(MAX_TITULO)
  })
})

describe('normalizarNota', () => {
  it('recorta los espacios de los extremos', () => {
    expect(normalizarNota('  Me encanta\n')).toBe('Me encanta')
  })

  it.each(['', '   \n '])('rechaza una nota vacía (%j)', (valor) => {
    expect(errorDe(() => normalizarNota(valor))).toMatchObject({ code: 'INVALID_NOTE' })
  })

  it('admite 2.000 caracteres y rechaza 2.001', () => {
    expect(normalizarNota('a'.repeat(MAX_NOTA))).toHaveLength(MAX_NOTA)
    expect(errorDe(() => normalizarNota('a'.repeat(MAX_NOTA + 1)))).toMatchObject({
      code: 'INVALID_NOTE',
      httpStatus: 422,
    })
  })
})

describe('exigirCupo', () => {
  it('deja pasar con 499 fotos', () => {
    expect(() => exigirCupo(499)).not.toThrow()
  })

  it('lanza MOODBOARD_IMAGE_LIMIT con 500', () => {
    expect(errorDe(() => exigirCupo(500))).toMatchObject({
      code: 'MOODBOARD_IMAGE_LIMIT',
      httpStatus: 422,
    })
  })
})

describe('exigirActiva', () => {
  it('deja pasar una foto sin archivar', () => {
    expect(() => exigirActiva({ archivedAt: null })).not.toThrow()
  })

  it('lanza MOODBOARD_IMAGE_ARCHIVED si está archivada', () => {
    expect(errorDe(() => exigirActiva({ archivedAt: new Date() }))).toMatchObject({
      code: 'MOODBOARD_IMAGE_ARCHIVED',
      httpStatus: 422,
    })
  })
})

describe('ProveedorNoCompartibleError', () => {
  it('lleva los ids en details.eventVendorIds', () => {
    const error = new ProveedorNoCompartibleError(['a', 'b'])
    expect(error.code).toBe('MOODBOARD_VENDOR_NOT_SHAREABLE')
    expect(error.details).toEqual({ eventVendorIds: ['a', 'b'] })
  })
})

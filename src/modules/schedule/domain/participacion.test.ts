import { UnprocessableError } from '@/shared/domain'
import {
  ANTELACION_RECORDATORIO_MS,
  cambiaLaHora,
  debeAvisar,
  debeProgramarse,
  MAX_NOTA,
  momentoDelRecordatorio,
  normalizarNota,
} from './participacion'

const MIN = 60_000
const t0 = new Date('2026-12-01T18:00:00Z')

describe('cambiaLaHora', () => {
  const antes = { startsAt: t0, endsAt: null }

  it('no cambia si sólo se toca el título', () => {
    expect(cambiaLaHora(antes, {})).toBe(false)
  })

  it('no cambia con el mismo startsAt, aunque sea otra instancia de Date', () => {
    expect(cambiaLaHora(antes, { startsAt: new Date(t0.getTime()) })).toBe(false)
  })

  it('cambia con un startsAt distinto', () => {
    expect(cambiaLaHora(antes, { startsAt: new Date(t0.getTime() + MIN) })).toBe(true)
  })

  it('cambia si endsAt pasa de null a una fecha', () => {
    expect(cambiaLaHora(antes, { endsAt: new Date(t0.getTime() + MIN) })).toBe(true)
  })

  it('no cambia con el mismo endsAt', () => {
    const fin = new Date(t0.getTime() + 60 * MIN)
    expect(cambiaLaHora({ startsAt: t0, endsAt: fin }, { endsAt: new Date(fin.getTime()) })).toBe(
      false,
    )
  })

  it('cambia si endsAt pasa de una fecha a null', () => {
    const fin = new Date(t0.getTime() + 60 * MIN)
    expect(cambiaLaHora({ startsAt: t0, endsAt: fin }, { endsAt: null })).toBe(true)
  })
})

describe('recordatorio', () => {
  it('se programa 15 minutos antes de startsAt', () => {
    expect(ANTELACION_RECORDATORIO_MS).toBe(900_000)
    expect(momentoDelRecordatorio(t0).getTime()).toBe(t0.getTime() - 15 * MIN)
  })

  it('debeProgramarse con 16 minutos de margen', () => {
    expect(debeProgramarse(t0, new Date(t0.getTime() - 16 * MIN))).toBe(true)
  })

  it('no debeProgramarse con 15 minutos o menos', () => {
    expect(debeProgramarse(t0, new Date(t0.getTime() - 15 * MIN))).toBe(false)
    expect(debeProgramarse(t0, new Date(t0.getTime() - 5 * MIN))).toBe(false)
  })
})

describe('debeAvisar', () => {
  const ahora = new Date(t0.getTime() - 15 * MIN)

  it('avisa con el ítem PENDING, el mismo startsAt y a tiempo', () => {
    expect(debeAvisar({ status: 'PENDING', startsAt: t0 }, new Date(t0.getTime()), ahora)).toBe(
      true,
    )
  })

  it('avisa justo en startsAt', () => {
    expect(debeAvisar({ status: 'PENDING', startsAt: t0 }, t0, t0)).toBe(true)
  })

  it('no avisa si el ítem está DONE o IN_PROGRESS', () => {
    expect(debeAvisar({ status: 'DONE', startsAt: t0 }, t0, ahora)).toBe(false)
    expect(debeAvisar({ status: 'IN_PROGRESS', startsAt: t0 }, t0, ahora)).toBe(false)
  })

  it('no avisa si el startsAt del job ya no es el del ítem', () => {
    const otro = new Date(t0.getTime() + 30 * MIN)
    expect(debeAvisar({ status: 'PENDING', startsAt: otro }, t0, ahora)).toBe(false)
  })

  it('no avisa si ya pasó startsAt', () => {
    const tarde = new Date(t0.getTime() + 1)
    expect(debeAvisar({ status: 'PENDING', startsAt: t0 }, t0, tarde)).toBe(false)
  })
})

describe('normalizarNota', () => {
  it('recorta los espacios de los extremos', () => {
    expect(normalizarNota('  hola  ')).toBe('hola')
  })

  it('acepta exactamente 2.000 caracteres', () => {
    expect(normalizarNota('a'.repeat(MAX_NOTA))).toHaveLength(2000)
  })

  it.each([
    ['vacía', ''],
    ['sólo espacios', '   \n '],
    ['2.001 caracteres', 'a'.repeat(2001)],
  ])('rechaza %s con INVALID_NOTE', (_nombre, valor) => {
    let error: unknown
    try {
      normalizarNota(valor)
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(UnprocessableError)
    expect(error).toMatchObject({ code: 'INVALID_NOTE' })
  })
})

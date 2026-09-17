export class InvalidCursorError extends Error {
  constructor() {
    super('El cursor de paginación no es válido')
    this.name = 'InvalidCursorError'
  }
}

export interface CursorValue {
  createdAt: Date
  id: string
}

export interface CursorPage<T> {
  items: T[]
  nextCursor: string | null
}

/**
 * Paginación por cursor, no por OFFSET: OFFSET degrada con la profundidad y,
 * peor, SALTA filas cuando alguien inserta mientras paginas. El par
 * (createdAt, id) es un orden total y estable, así que el cursor es exacto.
 *
 * Se codifica en base64url para que sea opaco: un cursor legible invita a
 * fabricarlo a mano, y entonces su formato pasa a ser API pública.
 */
export function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify({ c: value.createdAt.toISOString(), i: value.id })).toString(
    'base64url',
  )
}

export function decodeCursor(raw: string): CursorValue {
  try {
    const crudo: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))

    if (
      typeof crudo !== 'object' ||
      crudo === null ||
      typeof (crudo as { c?: unknown }).c !== 'string' ||
      typeof (crudo as { i?: unknown }).i !== 'string'
    ) {
      throw new InvalidCursorError()
    }

    const { c, i } = crudo as { c: string; i: string }
    const createdAt = new Date(c)
    if (Number.isNaN(createdAt.getTime())) throw new InvalidCursorError()

    return { createdAt, id: i }
  } catch {
    throw new InvalidCursorError()
  }
}

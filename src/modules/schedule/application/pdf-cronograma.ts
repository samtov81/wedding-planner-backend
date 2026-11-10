import type { ItemConAsignaciones, NotaDeItem } from './schedule-item.repository'

/**
 * Lo que va en el PDF del cronograma, ya decidido (spec 2026-11-10 §8). Es un
 * modelo PURO: aquí se resuelve QUIÉN ve QUÉ (las notas, sólo el planner) y en
 * qué zona horaria sale cada hora; el renderizador (`pdf.port.ts`) sólo pinta.
 * Alternativa descartada: pasar al renderizador los ítems y el rol y que él
 * decida; el invariante "ni un byte de notas para la pareja" quedaría repartido
 * entre la maquetación y el filtrado, y sin test sencillo que lo cace.
 */
export interface DocumentoCronograma {
  titulo: string
  /** Fecha de la boda en texto largo, en la zona del evento; `''` si el evento no la tiene. */
  fecha: string
  items: {
    /** `HH:mm` en la zona del evento, o `HH:mm–HH:mm` si hay fin. */
    hora: string
    titulo: string
    lugar: string | null
    descripcion: string | null
    estado: string
    /** `"<name> (<categoryName>)"`, con ` ✓` al final si ya confirmó. */
    proveedores: string[]
    /** Vacío siempre si no se pasaron notas (quien no es planner). */
    notas: string[]
  }[]
}

export interface EventoParaPdf {
  name: string
  weddingDate: Date | null
  timezone: string
}

/** `Intl.DateTimeFormat` es caro de construir: uno por zona, no uno por hora. */
const formateadoresDeHora = new Map<string, Intl.DateTimeFormat>()

function horaLocal(instante: Date, timezone: string): string {
  let f = formateadoresDeHora.get(timezone)
  if (f === undefined) {
    // `hourCycle: 'h23'` evita el "24:00" de algunos motores a medianoche.
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formateadoresDeHora.set(timezone, f)
  }
  return f.format(instante)
}

/** `YYYY-MM-DD` del instante en esa zona: la fecha del nombre del fichero. */
export function fechaIsoLocal(instante: Date, timezone: string): string {
  // `en-CA` formatea como `YYYY-MM-DD` sin tener que recomponer las partes.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instante)
}

function fechaLarga(instante: Date, timezone: string): string {
  return new Intl.DateTimeFormat('es-ES', { timeZone: timezone, dateStyle: 'full' }).format(
    instante,
  )
}

function lugarDe(item: ItemConAsignaciones): string | null {
  const l = item.location
  if (l === null) return null
  return l.name === null ? l.address : `${l.name}, ${l.address}`
}

/**
 * `notasPorItem === null` significa "quien pide no es planner": las notas salen
 * `[]` en TODOS los ítems, aunque se las hubieran pasado (spec 2026-11-10 §7,
 * Review Focus 5). Quien llama no consulta las notas en ese caso; esto es la
 * segunda barrera. Un ítem sin entrada en el mapa tampoco lleva notas.
 */
export function componerDocumento(
  evento: EventoParaPdf,
  items: ItemConAsignaciones[],
  notasPorItem: Map<string, NotaDeItem[]> | null,
): DocumentoCronograma {
  return {
    titulo: evento.name,
    fecha: evento.weddingDate === null ? '' : fechaLarga(evento.weddingDate, evento.timezone),
    items: items.map((i) => {
      const inicio = horaLocal(i.startsAt, evento.timezone)
      return {
        hora: i.endsAt === null ? inicio : `${inicio}–${horaLocal(i.endsAt, evento.timezone)}`,
        titulo: i.title,
        lugar: lugarDe(i),
        descripcion: i.description,
        estado: i.status,
        proveedores: i.vendors.map(
          (v) => `${v.name} (${v.categoryName})${v.confirmed ? ' ✓' : ''}`,
        ),
        notas:
          notasPorItem === null
            ? []
            : (notasPorItem.get(i.id) ?? []).map((n) => `${n.author.name}: ${n.body}`),
      }
    }),
  }
}

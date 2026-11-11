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
  /**
   * Fecha de la boda en texto largo (`Saturday, June 12, 2027`); `''` si el
   * evento no la tiene. Se formatea en UTC, NO en la zona del evento: ver
   * `fechaDeBodaIso`.
   */
  fecha: string
  items: {
    /**
     * Subtítulo de día (`Friday, June 11`) que va ANTES de este ítem cuando su
     * fecha local (zona del evento) cambia respecto a la del ítem anterior;
     * `null` si es el mismo día. Para el primer ítem, "el anterior" es el día
     * de la boda: un cronograma que empieza el día de la boda no repite la
     * fecha de la cabecera, y uno sin `weddingDate` lleva siempre subtítulo en
     * el primero. Alternativa descartada: un subtítulo en cada ítem, que en
     * el caso normal (todo el mismo día) repite la cabecera una y otra vez.
     */
    dia: string | null
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

/** `YYYY-MM-DD` del instante en esa zona: la fecha LOCAL de un ítem, para agruparlo por día. */
function fechaIsoLocal(instante: Date, timezone: string): string {
  // `en-CA` formatea como `YYYY-MM-DD` sin tener que recomponer las partes.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instante)
}

/**
 * `YYYY-MM-DD` de la boda. `weddingDate` es una FECHA de calendario (columna
 * `date`), que Prisma entrega como la medianoche UTC de ese día: leerla en la
 * zona del evento la adelantaría un día al oeste de UTC (2027-06-12 00:00Z es
 * el 11 a las 19:00 en Bogotá). Por eso se lee en UTC, y sólo las HORAS de los
 * ítems, que sí son instantes, van en la zona del evento. La usan la cabecera
 * y el nombre del fichero (`descargar-pdf.use-case.ts`).
 */
export function fechaDeBodaIso(weddingDate: Date): string {
  return weddingDate.toISOString().slice(0, 10)
}

const fechaLargaUtc = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', dateStyle: 'full' })

/** `Friday, June 11`: el subtítulo de día, en la zona del evento (los ítems son instantes). */
function diaLocal(instante: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(instante)
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
  let diaAnterior = evento.weddingDate === null ? null : fechaDeBodaIso(evento.weddingDate)
  return {
    titulo: evento.name,
    fecha: evento.weddingDate === null ? '' : fechaLargaUtc.format(evento.weddingDate),
    items: items.map((i) => {
      const inicio = horaLocal(i.startsAt, evento.timezone)
      const dia = fechaIsoLocal(i.startsAt, evento.timezone)
      const cambiaDeDia = dia !== diaAnterior
      diaAnterior = dia
      return {
        dia: cambiaDeDia ? diaLocal(i.startsAt, evento.timezone) : null,
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

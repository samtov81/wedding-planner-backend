/**
 * Puerto PÚBLICO del cronograma para quien cambia el estado de una
 * contratación (`vendors`). Cuando una contratación vuelve a `BOOKED`, sus
 * asignaciones futuras vuelven a ser vigentes y necesitan recordatorio (spec
 * 2026-11-10 §5, "Recontratación"): mientras estuvo cancelada, el worker
 * descartó sus jobs y ningún cambio de hora le encoló otros.
 *
 * Lo implementa `ProgramarRecordatorios` y lo exporta
 * `ScheduleRemindersModule`, que no importa `VendorsModule`: así `vendors`
 * consume el cronograma por su puerto sin cerrar un ciclo de módulos.
 * Alternativa descartada: que `vendors` emita un evento de dominio que el
 * cronograma escuche; no hay bus de eventos en el proyecto y un puerto de un
 * método es la forma que ya usan los demás módulos (`NOTIFICATION_PORT`).
 *
 * Nunca lanza: lo llaman DESPUÉS del commit y un aviso que no se programa no
 * debe convertir en error un PATCH ya guardado.
 */
export interface RecordatoriosPort {
  reprogramarContratacion(eventVendorId: string): Promise<void>
}

export const RECORDATORIOS_PORT = Symbol('RECORDATORIOS_PORT')

import { Inject, Injectable } from '@nestjs/common'

import { ImportacionInvalidaError, type ErrorDeFila } from '../domain/guest-errors'
import { GUEST_REPOSITORY, type DatosCrearInvitado, type GuestRepository } from './guest.repository'

/**
 * Una fila tal como llega del borde HTTP: o ya validada, o con los fallos de
 * esquema que encontró el borde. La validación de FORMA vive en `interfaces/`
 * (el esquema Zod), la de ESTADO —duplicados— aquí.
 */
export type FilaImportacion =
  | { ok: true; datos: Omit<DatosCrearInvitado, 'eventId'> }
  | { ok: false; fallos: { field: string; message: string }[] }

@Injectable()
export class ImportGuestsUseCase {
  constructor(@Inject(GUEST_REPOSITORY) private readonly invitados: GuestRepository) {}

  /**
   * Todo o nada. Se juntan TODOS los errores antes de decidir —esquema, correo
   * repetido dentro del archivo, correo ya invitado al evento— para que quien
   * importa corrija el archivo de una vez y no fila a fila.
   *
   * La comparación de correos no distingue mayúsculas: `Ana@x.com` y
   * `ana@x.com` son el mismo buzón. El índice único de la tabla sí las
   * distingue; la importación es más estricta a propósito, porque un CSV
   * exportado de otra herramienta es justo donde aparecen esas variantes.
   *
   * Entre la validación y la escritura alguien puede crear un invitado con uno
   * de estos correos: el índice lo para y `crearVarios` lanza
   * `EmailDuplicadoError` (409) sin haber insertado nada.
   */
  async ejecutar(eventId: string, filas: FilaImportacion[]): Promise<{ created: number }> {
    const errores: ErrorDeFila[] = []
    const validas: { row: number; datos: Omit<DatosCrearInvitado, 'eventId'> }[] = []

    filas.forEach((fila, indice) => {
      const row = indice + 1
      if (fila.ok) {
        validas.push({ row, datos: fila.datos })
        return
      }
      for (const fallo of fila.fallos) errores.push({ row, ...fallo, code: 'INVALID' })
    })

    const primeraFilaDe = new Map<string, number>()
    for (const { row, datos } of validas) {
      if (datos.email === null) continue
      const clave = datos.email.toLowerCase()
      const primera = primeraFilaDe.get(clave)
      if (primera === undefined) {
        primeraFilaDe.set(clave, row)
      } else {
        errores.push({
          row,
          field: 'email',
          code: 'DUPLICATED_IN_FILE',
          message: `El correo ya aparece en la fila ${String(primera)}`,
        })
      }
    }

    const existentes = await this.invitados.emailsExistentes(eventId, [...primeraFilaDe.keys()])
    for (const { row, datos } of validas) {
      if (datos.email !== null && existentes.has(datos.email.toLowerCase())) {
        errores.push({
          row,
          field: 'email',
          code: 'ALREADY_INVITED',
          message: 'Ya hay un invitado con ese correo en este evento',
        })
      }
    }

    if (errores.length > 0) {
      throw new ImportacionInvalidaError(errores.sort((a, b) => a.row - b.row))
    }

    const created = await this.invitados.crearVarios(
      validas.map(({ datos }) => ({ ...datos, eventId })),
    )
    return { created }
  }
}

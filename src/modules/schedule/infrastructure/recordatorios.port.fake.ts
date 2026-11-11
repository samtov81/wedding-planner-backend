import type { RecordatoriosPort } from '../application/recordatorios.port'

/**
 * Doble del puerto público de recordatorios (ruling H1), para los tests de
 * `vendors`: registra qué contrataciones se pidió reprogramar. Como el
 * adaptador real (`ProgramarRecordatorios`), nunca lanza.
 */
export class RecordatoriosPortEnMemoria implements RecordatoriosPort {
  readonly reprogramadas: string[] = []

  reprogramarContratacion(eventVendorId: string): Promise<void> {
    this.reprogramadas.push(eventVendorId)
    return Promise.resolve()
  }
}

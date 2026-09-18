export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** Etiquetas del proveedor; sirven para segmentar métricas de entrega. */
  tags?: Record<string, string>
  /**
   * Clave de idempotencia hacia el proveedor (`Idempotency-Key` en Resend): dos
   * envíos con la misma clave producen UN correo y devuelven el mismo id. Cubre
   * el reintento que llega después de un envío que sí salió. Resend la recuerda
   * 24 h: fuera de esa ventana no protege.
   */
  idempotencyKey?: string
}

export interface MailResult {
  /** Id del proveedor. Es la clave por la que el webhook casa el evento. */
  providerMessageId: string
}

export interface MailPort {
  send(mensaje: MailMessage): Promise<MailResult>
}

export const MAIL_PORT = Symbol('MAIL_PORT')

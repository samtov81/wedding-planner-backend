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
  /**
   * Id del proveedor. Es la clave por la que el webhook casa el evento.
   *
   * OPCIONAL porque un envío puede constar como hecho sin que el proveedor nos
   * dé el id: un 409 de idempotencia de Resend dice que el correo de esa clave
   * YA salió, pero no devuelve su id. El correo está enviado; lo que se pierde
   * es poder casar sus webhooks de entrega, no el envío.
   */
  providerMessageId?: string
}

export interface MailPort {
  send(mensaje: MailMessage): Promise<MailResult>
}

export const MAIL_PORT = Symbol('MAIL_PORT')

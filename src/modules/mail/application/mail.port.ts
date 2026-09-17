export interface MailMessage {
  to: string
  subject: string
  html: string
  text: string
  /** Etiquetas del proveedor; sirven para segmentar métricas de entrega. */
  tags?: Record<string, string>
}

export interface MailResult {
  /** Id del proveedor. Es la clave por la que el webhook casa el evento. */
  providerMessageId: string
}

export interface MailPort {
  send(mensaje: MailMessage): Promise<MailResult>
}

export const MAIL_PORT = Symbol('MAIL_PORT')

/**
 * Puerto de verificación de la firma de un webhook del proveedor de correo. El
 * controlador depende de esto y no de `svix`: el paquete vive sólo en
 * `infrastructure/`.
 */
export interface WebhookSignatureVerifier {
  /**
   * Verifica la firma sobre los BYTES crudos recibidos y, sólo si casa,
   * devuelve el payload parseado (todavía sin validar: eso es del borde).
   * Lanza `FirmaInvalidaError` si la firma falta, no casa o ha caducado.
   */
  verificar(cuerpoCrudo: Buffer, cabeceras: Record<string, string>): unknown
}

export const WEBHOOK_SIGNATURE_VERIFIER = Symbol('WEBHOOK_SIGNATURE_VERIFIER')

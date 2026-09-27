import { z } from 'zod'

/**
 * Lo mínimo que el webhook necesita de un evento de Resend. Se valida DESPUÉS
 * de verificar la firma: antes, el cuerpo es de cualquiera y no merece ni que
 * se mire su forma.
 *
 * `data.email_id` es opcional en el esquema porque Resend también manda eventos
 * que no son de un correo (`contact.*`, `domain.*`) y esos no lo traen: se
 * aceptan con 2xx y se ignoran. Pero un evento `email.*` SIN `email_id` es un
 * cuerpo roto aunque venga firmado, y ese sí es un 400.
 *
 * Los campos que no se nombran se descartan (`z.object` los quita): no hay
 * motivo para que el resto del payload —destinatarios, asunto— circule más allá
 * del borde.
 */
export const eventoResendSchema = z
  .object({
    type: z.string().min(1),
    data: z.object({ email_id: z.string().min(1).optional() }),
  })
  .refine((evento) => !evento.type.startsWith('email.') || evento.data.email_id !== undefined, {
    message: 'Un evento email.* debe traer data.email_id',
    path: ['data', 'email_id'],
  })

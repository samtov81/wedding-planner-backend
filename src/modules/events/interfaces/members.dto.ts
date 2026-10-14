import { z } from 'zod'

/**
 * `budgetAccess` sólo admite `none`/`view`: `edit` es del creador y no se
 * concede. `.strict()` para que un `{ status: 'ACTIVE' }` no se ignore en
 * silencio: aceptar tiene su propia ruta, la del invitado.
 */
export const updateMemberSchema = z
  .object({
    role: z.enum(['COUPLE', 'PLANNER']).optional(),
    budgetAccess: z.enum(['none', 'view']).optional(),
  })
  .strict()
  .refine((d) => d.role !== undefined || d.budgetAccess !== undefined, {
    message: 'Indica al menos un cambio',
  })
export type UpdateMemberDto = z.infer<typeof updateMemberSchema>

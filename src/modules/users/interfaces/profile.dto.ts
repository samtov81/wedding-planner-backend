import { z } from 'zod'

export const actualizarPerfilSchema = z
  .object({ fullName: z.string().trim().min(1).max(200) })
  .strict()

export const keySubidaSchema = z.object({ key: z.string().trim().min(1).max(300) }).strict()

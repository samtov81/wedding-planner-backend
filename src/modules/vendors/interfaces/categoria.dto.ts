import { z } from 'zod'

import { FORMATO_SLUG } from '../domain/categoria'

/** El `slug` de una categoría. Si existe y está activa lo decide el caso de uso (422). */
export const slugDeCategoriaSchema = z.string().trim().max(50).regex(FORMATO_SLUG)

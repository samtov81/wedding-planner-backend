import type {
  ConversacionDePerfilVista,
  ConversacionVista,
  ConversationRepository,
  SalaVista,
} from './conversation.repository'

export type ConversacionLocalizada =
  | { tipo: 'directa'; vista: ConversacionVista }
  | { tipo: 'sala'; vista: SalaVista }
  | { tipo: 'perfil'; vista: ConversacionDePerfilVista }

/**
 * Las rutas `/conversations/:id/...` y el worker sirven a los tres tipos (1:1
 * de la parte 1, sala del evento de la parte 2 y contacto desde la ficha de la
 * parte 3): éste es el ÚNICO sitio que
 * decide de cuál se trata y si `userId` la ve. `buscar` sólo encuentra 1:1,
 * `buscarSala` sólo salas y `buscarPerfil` sólo `PROFILE`, así que el orden no cambia el resultado. null = no
 * existe o no la ve (el mismo 404 para los dos). Alternativa descartada: rutas
 * `/rooms/:id/...` duplicadas, que obligarían al frontend a dos hilos distintos.
 */
export async function localizarConversacion(
  repo: ConversationRepository,
  conversationId: string,
  userId: string,
): Promise<ConversacionLocalizada | null> {
  const directa = await repo.buscar(conversationId, userId)
  if (directa !== null) return { tipo: 'directa', vista: directa }
  const sala = await repo.buscarSala(conversationId, userId)
  if (sala !== null) return { tipo: 'sala', vista: sala }
  const perfil = await repo.buscarPerfil(conversationId, userId)
  return perfil === null ? null : { tipo: 'perfil', vista: perfil }
}

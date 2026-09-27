/** Lo que el propio usuario ve y edita de sí mismo en `/profile`. */
export interface PerfilPersonal {
  id: string
  email: string
  fullName: string
  /** URL prefirmada de corta vida, o `null` sin avatar o sin almacenamiento. */
  avatarUrl: string | null
}

/**
 * El evento, tal como lo conoce el dominio. Deliberadamente NO es el tipo que
 * genera Prisma: `assignedBudget` y compañía son `Decimal` del cliente, y
 * arrastrar ese tipo hasta aquí ataría el dominio al ORM.
 */
export interface Event {
  id: string
  name: string
  weddingDate: Date
  timezone: string
  venueLocation: string | null
  ownerId: string
  createdAt: Date
  updatedAt: Date
}

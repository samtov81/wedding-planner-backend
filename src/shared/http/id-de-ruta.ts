import type { DomainError } from '@/shared/domain'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Un id de ruta que no es UUID no puede existir: se responde con el MISMO 404
 * que un id inexistente, en vez de dejar que Prisma lo rechace como P2023 (500).
 */
export function idDeRuta(valor: string, error: () => DomainError): string {
  if (!UUID.test(valor)) throw error()
  return valor
}

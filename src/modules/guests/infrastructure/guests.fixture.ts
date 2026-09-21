import { GuestRepositoryEnMemoria } from './guest.repository.fake'

/**
 * Siembra compartida por los tests de los casos de uso de invitados. Vive
 * junto al doble —no en `application/`, donde la regla de dependencia prohíbe
 * mirar a `infrastructure/`— y la usan los cuatro ficheros en los que se partió
 * `list-guests.use-case.test.ts` (Tarea 11).
 */
export const EVENTO_A = '11111111-1111-4111-8111-111111111111'
export const EVENTO_B = '22222222-2222-4222-8222-222222222222'

/** Ids con forma de UUID: `decodeCursor` los exige desde la Tarea 7. */
export const A = (i: number): string => `aaaaaaaa-0000-4000-8000-00000000000${i}`
export const B0 = 'bbbbbbbb-0000-4000-8000-000000000000'

/**
 * Seis invitados de `EVENTO_A` —tres `Family`/`CONFIRMED`, tres
 * `Friends`/`PENDING`, con `createdAt` separados un segundo para que el orden
 * sea total— y uno de `EVENTO_B`, que ningún caso de uso debería ver nunca.
 */
export function repoSembrado(): GuestRepositoryEnMemoria {
  const repo = new GuestRepositoryEnMemoria()
  const base = new Date('2026-01-01T00:00:00.000Z')

  for (let i = 0; i < 6; i += 1) {
    repo.sembrar({
      id: A(i),
      eventId: EVENTO_A,
      name: `G0${i}`,
      email: `g0${i}@boda.test`,
      group: i < 3 ? 'Family' : 'Friends',
      rsvp: i < 3 ? 'CONFIRMED' : 'PENDING',
      dietary: null,
      createdAt: new Date(base.getTime() + i * 1000),
    })
  }
  repo.sembrar({
    id: B0,
    eventId: EVENTO_B,
    name: 'De otra boda',
    email: null,
    group: 'Family',
    rsvp: 'CONFIRMED',
    dietary: null,
    createdAt: base,
  })

  return repo
}

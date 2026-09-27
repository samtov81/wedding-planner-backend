import { randomUUID } from 'node:crypto'

import { Prisma, PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { InvitationRepository } from '../application/invitation.repository'
import { InvitadoNoEncontradoError } from '../domain/guest-errors'
import type { InvitationStatus } from '../domain/invitation'
import { InvitationRepositoryEnMemoria } from './invitation.repository.fake'
import { PrismaGuestRepository } from './prisma-guest.repository'
import { PrismaInvitationRepository } from './prisma-invitation.repository'

const TODOS: InvitationStatus[] = [
  'QUEUED',
  'SENT',
  'DELIVERED',
  'BOUNCED',
  'COMPLAINED',
  'RESPONDED',
]
const MAÑANA = (): Date => new Date(Date.now() + 86_400_000)

/**
 * Las guardas de escritura de la invitación, contra Postgres Y contra el doble,
 * con los mismos casos: si el doble fuera más permisivo que el adaptador, los
 * tests de caso de uso darían verdes que la base de datos desmiente (ruling H1).
 */
describe('Guardas de escritura de la invitación', () => {
  let pg: PostgresDeTest
  let prisma: PrismaClient
  let guestId: string
  let eventId: string
  /** Otro invitado del mismo evento: `caducarVigentesDe` no puede tocar lo suyo. */
  let otroGuestId: string

  beforeAll(async () => {
    pg = await startPostgres()
    prisma = new PrismaClient({ datasources: { db: { url: pg.url } } })

    const owner = await prisma.user.create({
      data: { email: 'owner@invitations.test', passwordHash: 'x', fullName: 'Owner' },
    })
    const evento = await prisma.event.create({
      data: { name: 'Boda', weddingDate: new Date('2027-06-12'), ownerId: owner.id },
    })
    const invitado = await prisma.guest.create({
      data: { eventId: evento.id, name: 'Invitada', email: 'i@test.com', group: 'Family' },
    })
    const otro = await prisma.guest.create({
      data: { eventId: evento.id, name: 'Otra', email: 'o@test.com', group: 'Family' },
    })
    eventId = evento.id
    guestId = invitado.id
    otroGuestId = otro.id
  }, 240_000)

  afterAll(async () => {
    await prisma.$disconnect()
    await pg.stop()
  }, 60_000)

  interface Implementacion {
    repo: InvitationRepository
    sembrar: (datos: {
      status: InvitationStatus
      expiresAt: Date
      resendMessageId?: string
      guestId?: string
    }) => Promise<string>
    estado: (id: string) => Promise<{ status: string; resendMessageId: string | null } | null>
    /**
     * Qué lanza ESTA implementación ante un `tokenHash` repetido. DIVERGENCIA
     * declarada: Prisma no traduce el `@unique` (sale su `P2002` crudo) y el
     * doble lo imita con un `Error` propio. Las dos rechazan, que es lo que el
     * caso de uso necesita; el error concreto no es el mismo.
     */
    esHashDuplicado: (error: unknown) => boolean
    caducidad: (id: string) => Promise<Date | undefined>
    respondidaEn: (id: string) => Promise<Date | null | undefined>
  }

  const implementaciones: Array<[string, () => Implementacion]> = [
    [
      'Prisma',
      () => ({
        repo: new PrismaInvitationRepository(prisma as unknown as PrismaService),
        sembrar: async ({ status, expiresAt, resendMessageId, guestId: deQuien }) =>
          (
            await prisma.guestInvitation.create({
              data: {
                guestId: deQuien ?? guestId,
                tokenHash: randomUUID(),
                status,
                expiresAt,
                resendMessageId: resendMessageId ?? null,
              },
            })
          ).id,
        estado: (id) =>
          prisma.guestInvitation.findUnique({
            where: { id },
            select: { status: true, resendMessageId: true },
          }),
        esHashDuplicado: (error) =>
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
        caducidad: async (id) =>
          (await prisma.guestInvitation.findUnique({ where: { id } }))?.expiresAt,
        respondidaEn: async (id) =>
          (await prisma.guestInvitation.findUnique({ where: { id } }))?.respondedAt,
      }),
    ],
    [
      'doble en memoria',
      () => {
        const repo = new InvitationRepositoryEnMemoria()
        // Las dos filas de `guests` que existen en Postgres: sin ellas, el
        // doble aceptaría un `crear` que la FK rechaza.
        repo.registrarInvitado({
          id: guestId,
          eventId,
          name: 'Invitada',
          email: 'i@test.com',
          event: { id: eventId, name: 'Boda', weddingDate: new Date('2027-06-12') },
        })
        repo.registrarInvitado({
          id: otroGuestId,
          eventId,
          name: 'Otra',
          email: 'o@test.com',
          event: { id: eventId, name: 'Boda', weddingDate: new Date('2027-06-12') },
        })
        return {
          repo,
          sembrar: ({ status, expiresAt, resendMessageId, guestId: deQuien }) =>
            Promise.resolve(
              repo.añadir({
                id: randomUUID(),
                status,
                expiresAt,
                resendMessageId: resendMessageId ?? null,
                guest: { id: deQuien ?? guestId, eventId },
              }).id,
            ),
          estado: (id) => {
            const fila = repo.buscar(id)
            return Promise.resolve(
              fila === undefined
                ? null
                : { status: fila.status, resendMessageId: fila.resendMessageId },
            )
          },
          esHashDuplicado: (error) =>
            error instanceof Error && error.message === 'tokenHash duplicado',
          caducidad: (id) => Promise.resolve(repo.buscar(id)?.expiresAt),
          respondidaEn: (id) => Promise.resolve(repo.buscar(id)?.respondedAt),
        }
      },
    ],
  ]

  describe.each(implementaciones)('%s', (_nombre, crear) => {
    let impl: Implementacion

    beforeEach(() => {
      impl = crear()
    })

    describe('crear', () => {
      it('un guestId que no existe es un 404 del invitado, no un 500 de Prisma', async () => {
        // Postgres lo rechaza con `P2003` (clave foránea) y el adaptador lo
        // traduce; el doble no puede ser más permisivo y aceptarlo.
        await expect(
          impl.repo.crear({
            guestId: randomUUID(),
            tokenHash: randomUUID(),
            expiresAt: MAÑANA(),
          }),
        ).rejects.toBeInstanceOf(InvitadoNoEncontradoError)
      })

      it('la fila creada cuelga del invitado real y de su evento', async () => {
        const caducidad = MAÑANA()

        const { id } = await impl.repo.crear({
          guestId,
          tokenHash: randomUUID(),
          expiresAt: caducidad,
        })

        expect(await impl.repo.buscarConInvitadoYEvento(id)).toMatchObject({
          status: 'QUEUED',
          expiresAt: caducidad,
          guest: { id: guestId, eventId, name: 'Invitada', email: 'i@test.com' },
          event: { id: eventId, name: 'Boda' },
        })
      })

      it('se encuentra por su hash, y dos invitaciones no pueden compartirlo', async () => {
        const tokenHash = randomUUID()
        const { id } = await impl.repo.crear({ guestId, tokenHash, expiresAt: MAÑANA() })

        expect((await impl.repo.buscarPorHash(tokenHash))?.id).toBe(id)
        // Las dos rechazan el `@unique`, cada una con SU error (ver
        // `esHashDuplicado`): el doble no puede aceptar lo que Postgres no acepta.
        const error = await impl.repo.crear({ guestId, tokenHash, expiresAt: MAÑANA() }).then(
          () => null,
          (fallo: unknown) => fallo,
        )
        expect(impl.esHashDuplicado(error)).toBe(true)
      })
    })

    describe('caducar (ruling C18)', () => {
      it('deja el token muerto: `expiresAt` en el pasado', async () => {
        const id = await impl.sembrar({ status: 'SENT', expiresAt: MAÑANA() })

        await impl.repo.caducar(id)

        expect((await impl.caducidad(id))?.getTime() ?? Infinity).toBeLessThanOrEqual(Date.now())
      })

      it('una invitación que ya no existe no lanza', async () => {
        await expect(impl.repo.caducar(randomUUID())).resolves.toBeUndefined()
      })
    })

    describe('marcarEnviada (ruling C21)', () => {
      it('pasa una invitación QUEUED a SENT con su id del proveedor', async () => {
        const id = await impl.sembrar({ status: 'QUEUED', expiresAt: MAÑANA() })

        await impl.repo.marcarEnviada(id, 're_1')

        expect(await impl.estado(id)).toEqual({ status: 'SENT', resendMessageId: 're_1' })
      })

      it('NO pisa un RESPONDED: un reintento del job no borra la respuesta del invitado', async () => {
        const id = await impl.sembrar({ status: 'RESPONDED', expiresAt: MAÑANA() })

        await impl.repo.marcarEnviada(id, 're_tarde')

        expect(await impl.estado(id)).toEqual({ status: 'RESPONDED', resendMessageId: null })
      })

      it.each(['DELIVERED', 'BOUNCED', 'COMPLAINED'] as const)(
        'tampoco retrocede un %s que el webhook ya escribió',
        async (status) => {
          const id = await impl.sembrar({ status, expiresAt: MAÑANA() })

          await impl.repo.marcarEnviada(id, 're_tarde')

          expect((await impl.estado(id))?.status).toBe(status)
        },
      )

      it('una invitación que ya no existe no lanza', async () => {
        await expect(impl.repo.marcarEnviada(randomUUID(), 're_1')).resolves.toBeUndefined()
      })
    })

    describe('actualizarEstadoPorMessageId (Tarea 15: devuelve lo que avanzó)', () => {
      it('devuelve la invitación que avanzó, con su invitado y su evento', async () => {
        const messageId = `re_${randomUUID()}`
        const id = await impl.sembrar({
          status: 'SENT',
          expiresAt: MAÑANA(),
          resendMessageId: messageId,
        })

        const avanzadas = await impl.repo.actualizarEstadoPorMessageId(messageId, 'BOUNCED')

        expect(avanzadas).toEqual([{ invitationId: id, guestId, eventId }])
        expect((await impl.estado(id))?.status).toBe('BOUNCED')
      })

      it('lo que no avanza (igual, más adelante o ajeno) no se devuelve', async () => {
        const messageId = `re_${randomUUID()}`
        const id = await impl.sembrar({
          status: 'RESPONDED',
          expiresAt: MAÑANA(),
          resendMessageId: messageId,
        })

        expect(await impl.repo.actualizarEstadoPorMessageId(messageId, 'DELIVERED')).toEqual([])
        expect(
          await impl.repo.actualizarEstadoPorMessageId(`re_${randomUUID()}`, 'DELIVERED'),
        ).toEqual([])
        expect((await impl.estado(id))?.status).toBe('RESPONDED')
      })

      it('el mismo webhook dos veces: sólo la primera avanza', async () => {
        const messageId = `re_${randomUUID()}`
        await impl.sembrar({ status: 'SENT', expiresAt: MAÑANA(), resendMessageId: messageId })

        expect(await impl.repo.actualizarEstadoPorMessageId(messageId, 'DELIVERED')).toHaveLength(1)
        expect(await impl.repo.actualizarEstadoPorMessageId(messageId, 'DELIVERED')).toEqual([])
      })
    })

    describe('marcarRespondida', () => {
      it.each(TODOS)('marca una invitación %s sin caducar', async (status) => {
        const id = await impl.sembrar({ status, expiresAt: MAÑANA() })

        expect(await impl.repo.marcarRespondida(id, new Date())).toBe(true)
        expect((await impl.estado(id))?.status).toBe('RESPONDED')
      })

      it('sobre una RESPONDED devuelve true y actualiza `respondedAt`: el RSVP se puede cambiar', async () => {
        // Bloque A §2: la única escritura que pone RESPONDED sobre RESPONDED.
        const id = await impl.sembrar({ status: 'DELIVERED', expiresAt: MAÑANA() })
        const primera = new Date(Date.now() - 60_000)
        const segunda = new Date()

        expect(await impl.repo.marcarRespondida(id, primera)).toBe(true)
        expect(await impl.repo.marcarRespondida(id, segunda)).toBe(true)

        expect((await impl.estado(id))?.status).toBe('RESPONDED')
        expect(await impl.respondidaEn(id)).toEqual(segunda)
      })

      it('no reclama una invitación caducada, y la deja como estaba', async () => {
        const id = await impl.sembrar({ status: 'DELIVERED', expiresAt: new Date(Date.now() - 1) })

        expect(await impl.repo.marcarRespondida(id, new Date())).toBe(false)
        expect((await impl.estado(id))?.status).toBe('DELIVERED')
      })

      it('no reclama una invitación que `caducar` acaba de invalidar (C18)', async () => {
        const id = await impl.sembrar({ status: 'SENT', expiresAt: MAÑANA() })
        await impl.repo.caducar(id)

        expect(await impl.repo.marcarRespondida(id, new Date(Date.now() + 1))).toBe(false)
      })
    })

    describe('caducarVigentesDe (ruling C24: reinvitar o cambiar el email mata los tokens viejos)', () => {
      it.each(TODOS)(
        'caduca a `ahora` una invitación %s vigente del invitado: su token deja de servir',
        async (status) => {
          const id = await impl.sembrar({ status, expiresAt: MAÑANA() })
          const ahora = new Date()

          await impl.repo.caducarVigentesDe(guestId, ahora)

          expect(await impl.caducidad(id)).toEqual(ahora)
          expect(await impl.repo.marcarRespondida(id, new Date(ahora.getTime() + 1))).toBe(false)
        },
      )

      it('caduca también una RESPONDED vigente: con el RSVP modificable, su token aún escribe', async () => {
        const respondida = await impl.sembrar({ status: 'RESPONDED', expiresAt: MAÑANA() })
        const ahora = new Date()

        await impl.repo.caducarVigentesDe(guestId, ahora)

        expect(await impl.caducidad(respondida)).toEqual(ahora)
        expect(await impl.repo.marcarRespondida(respondida, new Date(ahora.getTime() + 1))).toBe(
          false,
        )
      })

      it('no toca una ya caducada ni las de otro invitado', async () => {
        const manana = MAÑANA()
        const ayer = new Date(Date.now() - 86_400_000)
        const caducada = await impl.sembrar({ status: 'SENT', expiresAt: ayer })
        const ajena = await impl.sembrar({
          status: 'RESPONDED',
          expiresAt: manana,
          guestId: otroGuestId,
        })

        await impl.repo.caducarVigentesDe(guestId, new Date())

        expect(await impl.caducidad(caducada)).toEqual(ayer)
        expect(await impl.caducidad(ajena)).toEqual(manana)
      })
    })
  })

  describe('el plazo del RSVP en Postgres (bloque A §2)', () => {
    it('la lectura compuesta trae `rsvpDeadlineDays` del evento', async () => {
      const owner = await prisma.user.findUniqueOrThrow({
        where: { email: 'owner@invitations.test' },
      })
      const evento = await prisma.event.create({
        data: {
          name: 'Boda con plazo',
          weddingDate: new Date('2027-06-12'),
          ownerId: owner.id,
          rsvpDeadlineDays: 30,
        },
      })
      const invitado = await prisma.guest.create({
        data: { eventId: evento.id, name: 'Con plazo', email: null, group: 'Family' },
      })
      const tokenHash = randomUUID()
      await prisma.guestInvitation.create({
        data: { guestId: invitado.id, tokenHash, expiresAt: MAÑANA() },
      })
      const repo = new PrismaInvitationRepository(prisma as unknown as PrismaService)

      expect((await repo.buscarPorHash(tokenHash))?.event.rsvpDeadlineDays).toBe(30)
    })

    it('sin valor, la columna aplica 14 días', async () => {
      const evento = await prisma.event.findUniqueOrThrow({ where: { id: eventId } })

      expect(evento.rsvpDeadlineDays).toBe(14)
    })

    it.each([-1, 366])('el CHECK rechaza %i días', async (dias) => {
      await expect(
        prisma.event.update({ where: { id: eventId }, data: { rsvpDeadlineDays: dias } }),
      ).rejects.toThrow(/events_rsvp_deadline_days_rango/)
    })
  })

  describe('dentro de una unidad de trabajo de Prisma', () => {
    it('si algo falla después, la invitación y el invitado vuelven a como estaban', async () => {
      const invitaciones = new PrismaInvitationRepository(prisma as unknown as PrismaService)
      const invitados = new PrismaGuestRepository(prisma as unknown as PrismaService)
      const unidad = new PrismaUnidadDeTrabajo(prisma as unknown as PrismaService)
      const id = (
        await prisma.guestInvitation.create({
          data: { guestId, tokenHash: randomUUID(), status: 'DELIVERED', expiresAt: MAÑANA() },
        })
      ).id

      await expect(
        unidad.ejecutar(async () => {
          await invitaciones.marcarRespondida(id, new Date())
          await invitados.actualizar(eventId, guestId, { rsvp: 'CONFIRMED' })
          throw new Error('falla la notificación')
        }),
      ).rejects.toThrow('falla la notificación')

      expect((await prisma.guestInvitation.findUniqueOrThrow({ where: { id } })).status).toBe(
        'DELIVERED',
      )
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'PENDING',
      )
    })

    it('si todo va bien, las dos escrituras se confirman juntas', async () => {
      const invitaciones = new PrismaInvitationRepository(prisma as unknown as PrismaService)
      const invitados = new PrismaGuestRepository(prisma as unknown as PrismaService)
      const unidad = new PrismaUnidadDeTrabajo(prisma as unknown as PrismaService)
      const id = (
        await prisma.guestInvitation.create({
          data: { guestId, tokenHash: randomUUID(), status: 'DELIVERED', expiresAt: MAÑANA() },
        })
      ).id

      await unidad.ejecutar(async () => {
        await invitaciones.marcarRespondida(id, new Date())
        await invitados.actualizar(eventId, guestId, { rsvp: 'DECLINED' })
      })

      expect((await prisma.guestInvitation.findUniqueOrThrow({ where: { id } })).status).toBe(
        'RESPONDED',
      )
      expect((await prisma.guest.findUniqueOrThrow({ where: { id: guestId } })).rsvp).toBe(
        'DECLINED',
      )
      await prisma.guest.update({ where: { id: guestId }, data: { rsvp: 'PENDING' } })
    })

    it('caducarVigentesDe escribe con la transacción en curso: un rollback deja vivo el token', async () => {
      // Lo llama `UpdateGuestUseCase` dentro de una unidad de trabajo junto con
      // el cambio de email: si una de las dos escrituras no se confirma, la
      // otra tampoco.
      const invitaciones = new PrismaInvitationRepository(prisma as unknown as PrismaService)
      const unidad = new PrismaUnidadDeTrabajo(prisma as unknown as PrismaService)
      const caducidad = MAÑANA()
      const id = (
        await prisma.guestInvitation.create({
          data: { guestId: otroGuestId, tokenHash: randomUUID(), expiresAt: caducidad },
        })
      ).id

      await expect(
        unidad.ejecutar(async () => {
          await invitaciones.caducarVigentesDe(otroGuestId, new Date())
          throw new Error('falla el cambio de email')
        }),
      ).rejects.toThrow('falla el cambio de email')

      expect((await prisma.guestInvitation.findUniqueOrThrow({ where: { id } })).expiresAt).toEqual(
        caducidad,
      )
    })
  })
})

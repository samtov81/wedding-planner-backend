import { randomUUID } from 'node:crypto'

import { PrismaClient } from '@prisma/client'

import type { PrismaService } from '@/modules/database/prisma.service'
import { PrismaUnidadDeTrabajo } from '@/modules/database/transaccion'

import { startPostgres, type PostgresDeTest } from '../../../../test/support/containers'
import type { InvitationRepository } from '../application/invitation.repository'
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
    caducidad: (id: string) => Promise<Date | undefined>
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
        caducidad: async (id) =>
          (await prisma.guestInvitation.findUnique({ where: { id } }))?.expiresAt,
      }),
    ],
    [
      'doble en memoria',
      () => {
        const repo = new InvitationRepositoryEnMemoria()
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
          caducidad: (id) => Promise.resolve(repo.buscar(id)?.expiresAt),
        }
      },
    ],
  ]

  describe.each(implementaciones)('%s', (_nombre, crear) => {
    let impl: Implementacion

    beforeEach(() => {
      impl = crear()
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
      it.each(TODOS.filter((s) => s !== 'RESPONDED'))(
        'reclama una invitación %s sin caducar',
        async (status) => {
          const id = await impl.sembrar({ status, expiresAt: MAÑANA() })

          expect(await impl.repo.marcarRespondida(id, new Date())).toBe(true)
          expect((await impl.estado(id))?.status).toBe('RESPONDED')
        },
      )

      it('no reclama dos veces la misma invitación: el token es de un solo uso', async () => {
        const id = await impl.sembrar({ status: 'DELIVERED', expiresAt: MAÑANA() })

        expect(await impl.repo.marcarRespondida(id, new Date())).toBe(true)
        expect(await impl.repo.marcarRespondida(id, new Date())).toBe(false)
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
      it.each(TODOS.filter((s) => s !== 'RESPONDED'))(
        'caduca a `ahora` una invitación %s vigente del invitado: su token deja de servir',
        async (status) => {
          const id = await impl.sembrar({ status, expiresAt: MAÑANA() })
          const ahora = new Date()

          await impl.repo.caducarVigentesDe(guestId, ahora)

          expect(await impl.caducidad(id)).toEqual(ahora)
          expect(await impl.repo.marcarRespondida(id, new Date(ahora.getTime() + 1))).toBe(false)
        },
      )

      it('no toca una RESPONDED (ya gastada), una ya caducada ni las de otro invitado', async () => {
        const manana = MAÑANA()
        const ayer = new Date(Date.now() - 86_400_000)
        const respondida = await impl.sembrar({ status: 'RESPONDED', expiresAt: manana })
        const caducada = await impl.sembrar({ status: 'SENT', expiresAt: ayer })
        const ajena = await impl.sembrar({
          status: 'SENT',
          expiresAt: manana,
          guestId: otroGuestId,
        })

        await impl.repo.caducarVigentesDe(guestId, new Date())

        expect(await impl.caducidad(respondida)).toEqual(manana)
        expect(await impl.caducidad(caducada)).toEqual(ayer)
        expect(await impl.caducidad(ajena)).toEqual(manana)
      })
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

import { randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { io, type Socket as SocketCliente } from 'socket.io-client'

import { TokenService } from '@/modules/auth/application/token.service'
import { EventAccessService } from '@/modules/events/application/event-access.service'
import { EVENT_REPOSITORY } from '@/modules/events/application/event.repository'
import { EventRepositoryEnMemoria } from '@/modules/events/infrastructure/event.repository.fake'
import { USER_REPOSITORY } from '@/modules/users/application/user.repository'
import { UserRepositoryEnMemoria } from '@/modules/users/infrastructure/user.repository.fake'

import { salaDeEvento, salaDeUsuario, salaDeVendorsDeEvento } from '../application/salas'
import { NotificationsGateway } from './notifications.gateway'

type RespuestaJoin = { ok: true } | { ok: false; code: string }

const SECRETO = 'x'.repeat(32)

function usuario(id: string, systemRole: 'USER' | 'ADMIN' = 'USER') {
  return {
    id,
    email: `${id}@test.com`,
    fullName: id,
    systemRole,
    emailVerifiedAt: null,
    passwordHash: 'irrelevante',
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

/**
 * El gateway REAL sobre Socket.IO real (sin Redis: el adapter por defecto de
 * Nest basta para probar la autorización), con los dobles de usuarios y de
 * eventos detrás del MISMO `EventAccessService` que usa el REST.
 */
describe('NotificationsGateway', () => {
  const tokens = new TokenService({
    JWT_ACCESS_SECRET: SECRETO,
    JWT_ACCESS_TTL: '15m',
    REFRESH_TTL_DAYS: 30,
  })
  const eventId = randomUUID()
  const parejaId = randomUUID()
  const extrañoId = randomUUID()
  const vendorId = randomUUID()
  const exPlannerId = randomUUID()
  const adminId = randomUUID()

  let usuarios: UserRepositoryEnMemoria
  let eventos: EventRepositoryEnMemoria
  let app: INestApplication
  let gateway: NotificationsGateway
  let url: string
  const abiertos: SocketCliente[] = []

  beforeAll(async () => {
    usuarios = new UserRepositoryEnMemoria([
      usuario(parejaId),
      usuario(extrañoId),
      usuario(vendorId),
      usuario(exPlannerId),
      usuario(adminId, 'ADMIN'),
    ])
    eventos = new EventRepositoryEnMemoria()
    eventos.eventos.push({ id: eventId, ownerId: parejaId })
    eventos.membresias.push(
      { eventId, userId: parejaId, role: 'COUPLE', status: 'ACTIVE' },
      { eventId, userId: exPlannerId, role: 'PLANNER', status: 'REVOKED' },
    )
    eventos.perfiles.push({ id: 'perfil-vendor', userId: vendorId })
    eventos.eventVendors.push({
      id: randomUUID(),
      eventId,
      vendorProfileId: 'perfil-vendor',
      status: 'BOOKED',
    })

    const modulo = await Test.createTestingModule({
      providers: [
        NotificationsGateway,
        EventAccessService,
        { provide: TokenService, useValue: tokens },
        { provide: USER_REPOSITORY, useValue: usuarios },
        { provide: EVENT_REPOSITORY, useValue: eventos },
      ],
    }).compile()
    app = modulo.createNestApplication({ logger: false })
    await app.listen(0, '127.0.0.1')
    const { port } = (app.getHttpServer() as { address: () => AddressInfo }).address()
    url = `http://127.0.0.1:${port}/realtime`
    gateway = app.get(NotificationsGateway)
  })

  afterEach(() => {
    for (const socket of abiertos.splice(0)) socket.disconnect()
  })

  afterAll(async () => {
    await app.close()
  })

  function conectar(opciones: { auth: Record<string, unknown> }): SocketCliente {
    const socket = io(url, {
      auth: opciones.auth,
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    })
    abiertos.push(socket)
    return socket
  }

  function esperarConexion(socket: SocketCliente): Promise<void> {
    return new Promise((resolve, reject) => {
      socket.once('connect', () => resolve())
      socket.once('connect_error', (error) => reject(error))
    })
  }

  async function conectarComo(userId: string, systemRole: 'USER' | 'ADMIN' = 'USER') {
    const socket = conectar({ auth: { token: tokens.firmarAccess({ id: userId, systemRole }) } })
    await esperarConexion(socket)
    return socket
  }

  function emitirYEsperar(socket: SocketCliente, evento: string, datos: unknown) {
    return socket.timeout(5_000).emitWithAck(evento, datos) as Promise<RespuestaJoin>
  }

  /** Las salas vistas desde el SERVIDOR: lo que el cliente cree no cuenta. */
  function salasDe(socket: SocketCliente): string[] {
    const delServidor = gateway.server.sockets.get(socket.id ?? '')
    return delServidor === undefined ? [] : [...delServidor.rooms]
  }

  describe('conexión', () => {
    it('rechaza una conexión sin token', async () => {
      const socket = conectar({ auth: {} })

      await expect(esperarConexion(socket)).rejects.toThrow(/no autorizado/i)
    })

    it('rechaza un token inválido', async () => {
      const socket = conectar({ auth: { token: 'inventado' } })

      await expect(esperarConexion(socket)).rejects.toThrow(/no autorizado/i)
    })

    it('rechaza un token bien firmado de un usuario que ya no existe', async () => {
      // Mismo criterio que `JwtAuthGuard`: se RECARGA el usuario. Sin eso, un
      // usuario borrado seguiría escuchando su evento hasta que caducara el token.
      const token = tokens.firmarAccess({ id: randomUUID(), systemRole: 'USER' })
      const socket = conectar({ auth: { token } })

      await expect(esperarConexion(socket)).rejects.toThrow(/no autorizado/i)
    })

    it('rechaza un rol que no pertenece a SystemRole', async () => {
      const token = tokens.firmarAccess({ id: parejaId, systemRole: 'SUPERADMIN' })
      const socket = conectar({ auth: { token } })

      await expect(esperarConexion(socket)).rejects.toThrow(/no autorizado/i)
    })

    it('acepta un token válido y une al usuario a su sala personal', async () => {
      const socket = conectar({
        auth: { token: tokens.firmarAccess({ id: parejaId, systemRole: 'USER' }) },
      })

      await esperarConexion(socket)
      expect(salasDe(socket)).toContain(salaDeUsuario(parejaId))
      expect(salaDeUsuario(parejaId)).toBe(`user:${parejaId}`)
    })
  })

  describe('join', () => {
    it('deja entrar a la sala de un evento sólo con acceso', async () => {
      const socket = await conectarComo(parejaId)

      const respuesta = await emitirYEsperar(socket, 'join', { eventId })

      expect(respuesta).toEqual({ ok: true })
      expect(salasDe(socket)).toContain(salaDeEvento(eventId))
    })

    it('NIEGA la sala de un evento ajeno, con el mismo criterio que el REST', async () => {
      const socket = await conectarComo(extrañoId)

      const respuesta = await emitirYEsperar(socket, 'join', { eventId })

      expect(respuesta).toEqual({ ok: false, code: 'NOT_FOUND' })
      expect(salasDe(socket)).not.toContain(salaDeEvento(eventId))
      expect(salasDe(socket)).not.toContain(salaDeVendorsDeEvento(eventId))
    })

    it('un evento ajeno y uno inexistente, o un id que no es UUID, responden igual', async () => {
      // Sin oráculo: igual que el 404 del guard HTTP.
      const socket = await conectarComo(extrañoId)

      const respuestas = [
        await emitirYEsperar(socket, 'join', { eventId }),
        await emitirYEsperar(socket, 'join', { eventId: randomUUID() }),
        await emitirYEsperar(socket, 'join', { eventId: 'no-es-un-uuid' }),
        await emitirYEsperar(socket, 'join', 'basura'),
      ]

      for (const respuesta of respuestas)
        expect(respuesta).toEqual({ ok: false, code: 'NOT_FOUND' })
    })

    it('una membresía REVOKED no entra', async () => {
      const socket = await conectarComo(exPlannerId)

      expect(await emitirYEsperar(socket, 'join', { eventId })).toEqual({
        ok: false,
        code: 'NOT_FOUND',
      })
    })

    it('un vendor contratado entra en la sala del evento', async () => {
      const socket = await conectarComo(vendorId)

      expect(await emitirYEsperar(socket, 'join', { eventId })).toEqual({ ok: true })
    })

    it('...pero en la de vendors: no oye lo que sólo pueden leer COUPLE y PLANNER', async () => {
      // Por REST el vendor no ve invitados (403 en todo `/guests`); el socket
      // no puede darle lo que el HTTP le niega.
      const socket = await conectarComo(vendorId)

      await emitirYEsperar(socket, 'join', { eventId })

      expect(salasDe(socket)).toContain(salaDeVendorsDeEvento(eventId))
      expect(salasDe(socket)).not.toContain(salaDeEvento(eventId))
    })

    it('un ADMIN entra, como en el REST', async () => {
      const socket = await conectarComo(adminId, 'ADMIN')

      expect(await emitirYEsperar(socket, 'join', { eventId })).toEqual({ ok: true })
      expect(salasDe(socket)).toContain(salaDeEvento(eventId))
    })

    it('cada join vuelve a autenticar: un usuario borrado tras conectar ya no entra', async () => {
      const efimeroId = randomUUID()
      const efimeros = new UserRepositoryEnMemoria([usuario(efimeroId)])
      const findById = vi
        .spyOn(usuarios, 'findById')
        .mockImplementation((id) => efimeros.findById(id))
      eventos.membresias.push({ eventId, userId: efimeroId, role: 'PLANNER', status: 'ACTIVE' })
      const socket = await conectarComo(efimeroId)

      findById.mockResolvedValue(null)
      const respuesta = await emitirYEsperar(socket, 'join', { eventId })
      findById.mockRestore()

      expect(respuesta).toEqual({ ok: false, code: 'UNAUTHORIZED' })
      expect(salasDe(socket)).not.toContain(salaDeEvento(eventId))
    })
  })

  describe('leave', () => {
    it('sale de las salas del evento', async () => {
      const socket = await conectarComo(parejaId)
      await emitirYEsperar(socket, 'join', { eventId })

      expect(await emitirYEsperar(socket, 'leave', { eventId })).toEqual({ ok: true })

      expect(salasDe(socket)).not.toContain(salaDeEvento(eventId))
      expect(salasDe(socket)).toContain(salaDeUsuario(parejaId))
    })
  })
})

import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'

import { ConversationRepositoryEnMemoria } from '../infrastructure/conversation.repository.fake'
import {
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
  SalaNoDisponibleError,
} from '../domain/messaging-errors'
import { ListMessagesUseCase } from './list-messages.use-case'
import { ListRoomReadersUseCase } from './list-room-readers.use-case'
import { ListRoomsUseCase } from './list-rooms.use-case'
import { MarkConversationUseCase } from './mark-conversation.use-case'
import { OpenRoomUseCase } from './open-room.use-case'
import { SendMessageUseCase } from './send-message.use-case'

const EVENTO = 'e1'
const PAREJA = 'u-pareja'
const PLANNER = 'u-planner'
const TARDE = 'u-tarde'
const PROV = 'u-prov'
const ADMIN = 'u-admin'

function escenario() {
  const repo = new ConversationRepositoryEnMemoria()
  repo.registrarEvento(EVENTO, 'Boda')
  repo.fijarPublicado(EVENTO, true)
  repo.registrarMiembro(EVENTO, PAREJA, 'COUPLE', 'ACTIVE', 'Pareja')
  repo.registrarMiembro(EVENTO, PLANNER, 'PLANNER', 'ACTIVE', 'Planner')
  repo.registrarProveedor(EVENTO, PROV, 'Foto', true)
  const cola = new InMemoryQueueAdapter()
  return {
    repo,
    cola,
    abrirSala: new OpenRoomUseCase(repo),
    salas: new ListRoomsUseCase(repo),
    enviar: new SendMessageUseCase(repo, cola),
    marcar: new MarkConversationUseCase(repo, cola),
    mensajes: new ListMessagesUseCase(repo),
    lectores: new ListRoomReadersUseCase(repo),
  }
}

describe('casos de uso de la sala del evento', () => {
  // Cada envío en su propio milisegundo: con el mismo `createdAt` el orden lo
  // decide el id (aleatorio) y "antes/después de salir" sería una moneda al aire.
  let reloj = new Date('2026-11-02T10:00:00.000Z').getTime()
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(reloj)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const avanzar = (): void => {
    reloj += 1000
    vi.setSystemTime(reloj)
  }

  it('el creador abre la sala vacía', async () => {
    const { abrirSala } = escenario()
    const sala = await abrirSala.ejecutar(PAREJA, EVENTO)
    expect(sala).toMatchObject({ memberCount: 2, lastMessage: null, readOnly: false })
  })

  it('un proveedor o un admin sin membresía reciben SalaNoDisponibleError', async () => {
    const { abrirSala } = escenario()
    await abrirSala.ejecutar(PAREJA, EVENTO)
    await expect(abrirSala.ejecutar(PROV, EVENTO)).rejects.toBeInstanceOf(SalaNoDisponibleError)
    await expect(abrirSala.ejecutar(ADMIN, EVENTO)).rejects.toBeInstanceOf(SalaNoDisponibleError)
  })

  it('enviar fija los destinatarios sin el proveedor y encola el aviso', async () => {
    const { abrirSala, enviar, cola } = escenario()
    const { id } = await abrirSala.ejecutar(PAREJA, EVENTO)
    const r = await enviar.ejecutar(PAREJA, id, '  hola  ')
    expect(r.mensaje.body).toBe('hola')
    expect(r.destinatarios).toEqual([PLANNER])
    expect(cola.encolados.map((j) => j.nombre)).toEqual(['message.created'])
  })

  it('un revocado no escribe y no marca un mensaje posterior a su salida', async () => {
    const { repo, abrirSala, enviar, marcar } = escenario()
    const { id } = await abrirSala.ejecutar(PAREJA, EVENTO)
    const antes = await enviar.ejecutar(PAREJA, id, 'antes')
    repo.registrarMiembro(EVENTO, PLANNER, 'PLANNER', 'REVOKED', 'Planner')
    avanzar()
    const despues = await enviar.ejecutar(PAREJA, id, 'después')

    await expect(enviar.ejecutar(PLANNER, id, 'hola')).rejects.toBeInstanceOf(
      ConversacionSoloLecturaError,
    )
    await expect(marcar.ejecutar(PLANNER, id, 'read', despues.mensaje.id)).rejects.toBeInstanceOf(
      ConversacionNoEncontradaError,
    )
    const r = await marcar.ejecutar(PLANNER, id, 'read', antes.mensaje.id)
    expect(r.marcas.readUpTo?.id).toBe(antes.mensaje.id)
  })

  it('un revocado sólo ve los mensajes hasta su salida', async () => {
    const { repo, abrirSala, enviar, mensajes } = escenario()
    const { id } = await abrirSala.ejecutar(PAREJA, EVENTO)
    await enviar.ejecutar(PAREJA, id, 'antes')
    repo.registrarMiembro(EVENTO, PLANNER, 'PLANNER', 'REVOKED', 'Planner')
    avanzar()
    await enviar.ejecutar(PAREJA, id, 'después')

    const r = await mensajes.ejecutar(PLANNER, id, { desde: null, limite: 10 })
    expect(r.pagina.items.map((m) => m.body)).toEqual(['antes'])
  })

  it('un ACTIVE que entró tarde y nunca abrió la sala puede marcar', async () => {
    const { repo, abrirSala, enviar, marcar } = escenario()
    const { id } = await abrirSala.ejecutar(PAREJA, EVENTO)
    const m = await enviar.ejecutar(PAREJA, id, 'historial')
    repo.registrarMiembro(EVENTO, TARDE, 'PLANNER', 'ACTIVE', 'Tarde')

    const r = await marcar.ejecutar(TARDE, id, 'read', m.mensaje.id)
    expect(r.marcas.readUpTo?.id).toBe(m.mensaje.id)
  })

  it('la página de la sala trae los miembros de hoy: sin revocados ni proveedores, con quien no abrió la sala', async () => {
    const { repo, abrirSala, enviar, mensajes } = escenario()
    const { id } = await abrirSala.ejecutar(PAREJA, EVENTO)
    repo.registrarMiembro(EVENTO, 'u-revocado', 'PLANNER', 'ACTIVE', 'Revocado')
    await enviar.ejecutar(PAREJA, id, 'hola')
    repo.registrarMiembro(EVENTO, 'u-revocado', 'PLANNER', 'REVOKED', 'Revocado')
    repo.registrarMiembro(EVENTO, TARDE, 'PLANNER', 'ACTIVE', 'Tarde')

    const r = await mensajes.ejecutar(PAREJA, id, { desde: null, limite: 10 })
    if (r.tipo !== 'sala') throw new Error('debía ser sala')
    expect(r.members).toEqual([
      { userId: PAREJA, displayName: 'Pareja', role: 'COUPLE' },
      { userId: PLANNER, displayName: 'Planner', role: 'PLANNER' },
      { userId: TARDE, displayName: 'Tarde', role: 'PLANNER' },
    ])
    // `marks` conserva a quien ya salió (hace falta para el "N de M" pasado).
    expect(r.marks.map((x) => x.userId)).toContain('u-revocado')
  })

  it('mensajes de sala: N de M sólo en mis mensajes y sube al leer', async () => {
    const { abrirSala, enviar, marcar, mensajes } = escenario()
    const { id } = await abrirSala.ejecutar(PAREJA, EVENTO)
    const mio = await enviar.ejecutar(PAREJA, id, 'mío')
    const ajeno = await enviar.ejecutar(PLANNER, id, 'ajeno')

    const antes = await mensajes.ejecutar(PAREJA, id, { desde: null, limite: 10 })
    if (antes.tipo !== 'sala') throw new Error('debía ser sala')
    expect(antes.recibos.get(mio.mensaje.id)).toEqual({
      recipientIds: [PLANNER],
      total: 1,
      delivered: 0,
      read: 0,
    })
    expect(antes.recibos.has(ajeno.mensaje.id)).toBe(false)

    await marcar.ejecutar(PLANNER, id, 'read', mio.mensaje.id)
    const despues = await mensajes.ejecutar(PAREJA, id, { desde: null, limite: 10 })
    if (despues.tipo !== 'sala') throw new Error('debía ser sala')
    expect(despues.recibos.get(mio.mensaje.id)).toMatchObject({ delivered: 1, read: 1 })
  })

  it('readers: el remitente ve quién leyó; cualquier otro recibe 404', async () => {
    const { repo, abrirSala, enviar, marcar, lectores } = escenario()
    repo.registrarMiembro(EVENTO, TARDE, 'PLANNER', 'ACTIVE', 'Tarde')
    const { id } = await abrirSala.ejecutar(PAREJA, EVENTO)
    const m = await enviar.ejecutar(PAREJA, id, 'hola')
    await marcar.ejecutar(PLANNER, id, 'read', m.mensaje.id)

    expect(await lectores.ejecutar(PAREJA, id, m.mensaje.id)).toEqual({
      read: [{ userId: PLANNER, displayName: 'Planner', role: 'PLANNER' }],
      unread: [{ userId: TARDE, displayName: 'Tarde', role: 'PLANNER' }],
    })
    await expect(lectores.ejecutar(PLANNER, id, m.mensaje.id)).rejects.toBeInstanceOf(
      ConversacionNoEncontradaError,
    )
  })

  it('salas: lista la del evento con su unreadTotal', async () => {
    const { abrirSala, enviar, salas } = escenario()
    const { id } = await abrirSala.ejecutar(PAREJA, EVENTO)
    await enviar.ejecutar(PAREJA, id, 'hola')
    const r = await salas.ejecutar(PLANNER)
    expect(r.unreadTotal).toBe(1)
    expect(r.items.map((s) => s.id)).toEqual([id])
  })
})

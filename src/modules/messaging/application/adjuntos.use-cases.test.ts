import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { SubidaDeAdjuntos } from '@/modules/storage/application/subida-de-adjuntos'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import { AdjuntosDeMensajesEnMemoria } from '../infrastructure/adjuntos-de-mensajes.fake'
import { ConversationRepositoryEnMemoria } from '../infrastructure/conversation.repository.fake'
import {
  AdjuntosNoPermitidosError,
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
} from '../domain/messaging-errors'
import type { AdjuntoVisible } from './adjuntos-de-mensajes.port'
import {
  BuscarAdjuntoVisible,
  DescargarAdjuntoUseCase,
  PrepararSubidaAdjuntoUseCase,
  prefijoAdjuntos,
} from './adjuntos.use-cases'
import { OpenConversationUseCase } from './open-conversation.use-case'
import { OpenRoomUseCase } from './open-room.use-case'
import { RequestContactUseCase } from './request-contact.use-case'
import { RespondContactUseCase } from './respond-contact.use-case'
import { SendMessageUseCase } from './send-message.use-case'

const EVENTO = 'e1'
const PAREJA = 'u-pareja'
const PLANNER = 'u-planner'
const TARDE = 'u-tarde'
const PROV = 'u-prov'
const PROV_B = 'u-prov-b'
const PEDIDOR = 'u-pedidor'
const PROV_FICHA = 'u-prov-ficha'

function escenario() {
  const repo = new ConversationRepositoryEnMemoria()
  repo.registrarEvento(EVENTO, 'Boda')
  repo.fijarPublicado(EVENTO, true)
  repo.registrarMiembro(EVENTO, PAREJA, 'COUPLE', 'ACTIVE', 'Pareja')
  repo.registrarMiembro(EVENTO, PLANNER, 'PLANNER', 'ACTIVE', 'Planner')
  repo.registrarProveedor(EVENTO, PROV, 'Foto', true)
  repo.registrarProveedor(EVENTO, PROV_B, 'Flores', true)
  repo.registrarUsuario(PEDIDOR, 'Ana')
  const ficha = repo.sembrarFicha(PROV_FICHA, { businessName: 'Foto Sol', publicada: true })
  const cola = new InMemoryQueueAdapter()
  const almacen = new ObjectStorageEnMemoria()
  const subidas = new SubidaDeAdjuntos(almacen)
  const buscar = new BuscarAdjuntoVisible(repo)
  return {
    repo,
    almacen,
    ficha,
    abrir: new OpenConversationUseCase(repo),
    abrirSala: new OpenRoomUseCase(repo),
    pedir: new RequestContactUseCase(repo, cola),
    responder: new RespondContactUseCase(repo, cola),
    enviar: new SendMessageUseCase(repo, cola, subidas),
    preparar: new PrepararSubidaAdjuntoUseCase(repo, subidas),
    buscar,
    descargar: new DescargarAdjuntoUseCase(buscar, subidas),
  }
}

type Escenario = ReturnType<typeof escenario>

/** Sube un PDF bajo el prefijo de la conversación y lo envía como adjunto. */
async function enviarConAdjunto(
  e: Escenario,
  userId: string,
  conversationId: string,
  name = 'factura.pdf',
) {
  const key = `${prefijoAdjuntos(EVENTO, conversationId)}/${name}`
  e.almacen.simularSubida(key, 'application/pdf', 4096)
  return e.enviar.ejecutar(userId, conversationId, '', { key, name })
}

/** Una conversación `PROFILE` aceptada entre PEDIDOR y PROV_FICHA. */
async function perfilAceptado(e: Escenario): Promise<string> {
  const { conversacion } = await e.pedir.ejecutar(PEDIDOR, e.ficha, 'hola')
  await e.responder.ejecutar(PROV_FICHA, conversacion.id, 'ACCEPTED')
  return conversacion.id
}

describe('casos de uso de adjuntos de mensajes', () => {
  // Cada envío en su propio milisegundo: "antes/después de salir" no puede
  // depender del id aleatorio (mismo criterio que `sala.use-cases.test.ts`).
  let reloj = new Date('2026-11-12T10:00:00.000Z').getTime()
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

  it('el prefijo de adjuntos es events/<eventId>/messages/<conversationId>', () => {
    expect(prefijoAdjuntos('e9', 'c7')).toBe('events/e9/messages/c7')
  })

  describe('enviar', () => {
    it('en la sala guarda el adjunto con cuerpo vacío y fija los destinatarios', async () => {
      const e = escenario()
      const { id } = await e.abrirSala.ejecutar(PAREJA, EVENTO)
      const r = await enviarConAdjunto(e, PAREJA, id)
      expect(r.mensaje).toMatchObject({
        body: '',
        attachment: { name: 'factura.pdf', contentType: 'application/pdf', bytes: 4096 },
      })
      expect(r.destinatarios).toEqual([PLANNER])
    })

    it('en una conversación PROFILE es 422 ATTACHMENTS_NOT_ALLOWED', async () => {
      const e = escenario()
      const id = await perfilAceptado(e)
      const error: unknown = await e.enviar
        .ejecutar(PEDIDOR, id, 'mira', { key: `events/x/messages/${id}/a.pdf`, name: 'a.pdf' })
        .catch((x: unknown) => x)
      expect(error).toBeInstanceOf(AdjuntosNoPermitidosError)
      expect(error).toMatchObject({ httpStatus: 422, code: 'ATTACHMENTS_NOT_ALLOWED' })
    })
  })

  describe('preparar la subida', () => {
    it('en una 1:1 devuelve una key bajo el prefijo de la conversación', async () => {
      const e = escenario()
      const { conversacion } = await e.abrir.ejecutar(PAREJA, EVENTO, PROV)
      const r = await e.preparar.ejecutar(PAREJA, conversacion.id, 'application/pdf', 1024)
      expect(r.key.startsWith(`${prefijoAdjuntos(EVENTO, conversacion.id)}/`)).toBe(true)
      expect(r.uploadUrl).toContain(r.key)
    })

    it('en una conversación PROFILE es 422', async () => {
      const e = escenario()
      const id = await perfilAceptado(e)
      await expect(
        e.preparar.ejecutar(PEDIDOR, id, 'application/pdf', 1024),
      ).rejects.toBeInstanceOf(AdjuntosNoPermitidosError)
    })

    it('un no participante recibe 404', async () => {
      const e = escenario()
      const { conversacion } = await e.abrir.ejecutar(PAREJA, EVENTO, PROV)
      await expect(
        e.preparar.ejecutar(PROV_B, conversacion.id, 'application/pdf', 1024),
      ).rejects.toBeInstanceOf(ConversacionNoEncontradaError)
    })

    it('en la sala en solo lectura es 403', async () => {
      const e = escenario()
      const { id } = await e.abrirSala.ejecutar(PAREJA, EVENTO)
      await e.enviar.ejecutar(PLANNER, id, 'estuve aquí', null)
      e.repo.registrarMiembro(EVENTO, PLANNER, 'PLANNER', 'REVOKED', 'Planner')
      await expect(
        e.preparar.ejecutar(PLANNER, id, 'application/pdf', 1024),
      ).rejects.toBeInstanceOf(ConversacionSoloLecturaError)
    })
  })

  describe('buscarVisible', () => {
    it('un participante de la 1:1 lo ve, con su evento y su key', async () => {
      const e = escenario()
      const { conversacion } = await e.abrir.ejecutar(PAREJA, EVENTO, PROV)
      const { mensaje } = await enviarConAdjunto(e, PROV, conversacion.id)
      expect(await e.buscar.buscarVisible(PAREJA, mensaje.id)).toEqual({
        messageId: mensaje.id,
        eventId: EVENTO,
        conversationId: conversacion.id,
        senderId: PROV,
        key: `${prefijoAdjuntos(EVENTO, conversacion.id)}/factura.pdf`,
        name: 'factura.pdf',
        contentType: 'application/pdf',
        bytes: 4096,
      })
    })

    it('un no participante recibe null', async () => {
      const e = escenario()
      const { conversacion } = await e.abrir.ejecutar(PAREJA, EVENTO, PROV)
      const { mensaje } = await enviarConAdjunto(e, PROV, conversacion.id)
      expect(await e.buscar.buscarVisible(PROV_B, mensaje.id)).toBeNull()
      expect(await e.buscar.buscarVisible(PLANNER, mensaje.id)).toBeNull()
    })

    it('un mensaje sin adjunto o inexistente es null', async () => {
      const e = escenario()
      const { conversacion } = await e.abrir.ejecutar(PAREJA, EVENTO, PROV)
      const { mensaje } = await e.enviar.ejecutar(PAREJA, conversacion.id, 'hola', null)
      expect(await e.buscar.buscarVisible(PAREJA, mensaje.id)).toBeNull()
      expect(await e.buscar.buscarVisible(PAREJA, 'no-existe')).toBeNull()
    })

    it('un miembro que entró en la sala después del mensaje lo ve', async () => {
      const e = escenario()
      const { id } = await e.abrirSala.ejecutar(PAREJA, EVENTO)
      const { mensaje } = await enviarConAdjunto(e, PAREJA, id)
      avanzar()
      e.repo.registrarMiembro(EVENTO, TARDE, 'PLANNER', 'ACTIVE', 'Tarde')
      expect(await e.buscar.buscarVisible(TARDE, mensaje.id)).toMatchObject({
        messageId: mensaje.id,
      })
    })

    it('quien salió de la sala antes del mensaje recibe null; lo anterior sí lo ve', async () => {
      const e = escenario()
      const { id } = await e.abrirSala.ejecutar(PAREJA, EVENTO)
      const antes = await enviarConAdjunto(e, PAREJA, id, 'antes.pdf')
      e.repo.registrarMiembro(EVENTO, PLANNER, 'PLANNER', 'REVOKED', 'Planner')
      avanzar()
      const despues = await enviarConAdjunto(e, PAREJA, id, 'despues.pdf')

      expect(await e.buscar.buscarVisible(PLANNER, antes.mensaje.id)).toMatchObject({
        name: 'antes.pdf',
      })
      expect(await e.buscar.buscarVisible(PLANNER, despues.mensaje.id)).toBeNull()
    })
  })

  describe('descargar', () => {
    it('con el adjunto visible devuelve una URL que descarga con su nombre', async () => {
      const e = escenario()
      const { conversacion } = await e.abrir.ejecutar(PAREJA, EVENTO, PROV)
      const { mensaje } = await enviarConAdjunto(e, PROV, conversacion.id, 'mi factura.pdf')
      const { url } = await e.descargar.ejecutar(PAREJA, conversacion.id, mensaje.id)
      expect(url).toContain(`?as=${encodeURIComponent('mi factura.pdf')}`)
    })

    it('con un conversationId ajeno al mensaje es 404', async () => {
      const e = escenario()
      const c1 = (await e.abrir.ejecutar(PAREJA, EVENTO, PROV)).conversacion
      const c2 = (await e.abrir.ejecutar(PAREJA, EVENTO, PLANNER)).conversacion
      const { mensaje } = await enviarConAdjunto(e, PROV, c1.id)
      await expect(e.descargar.ejecutar(PAREJA, c2.id, mensaje.id)).rejects.toBeInstanceOf(
        ConversacionNoEncontradaError,
      )
    })

    it('si no lo ve es 404', async () => {
      const e = escenario()
      const { conversacion } = await e.abrir.ejecutar(PAREJA, EVENTO, PROV)
      const { mensaje } = await enviarConAdjunto(e, PROV, conversacion.id)
      await expect(
        e.descargar.ejecutar(PROV_B, conversacion.id, mensaje.id),
      ).rejects.toBeInstanceOf(ConversacionNoEncontradaError)
    })
  })

  describe('doble AdjuntosDeMensajesEnMemoria', () => {
    it('sólo devuelve lo que se puso para ese usuario', async () => {
      const doble = new AdjuntosDeMensajesEnMemoria()
      const adjunto: AdjuntoVisible = {
        messageId: 'm1',
        eventId: EVENTO,
        conversationId: 'c1',
        senderId: PROV,
        key: 'events/e1/messages/c1/a.pdf',
        name: 'a.pdf',
        contentType: 'application/pdf',
        bytes: 10,
      }
      doble.poner(PAREJA, adjunto)
      expect(await doble.buscarVisible(PAREJA, 'm1')).toEqual(adjunto)
      expect(await doble.buscarVisible(PLANNER, 'm1')).toBeNull()
      expect(await doble.buscarVisible(PAREJA, 'm2')).toBeNull()
    })
  })
})

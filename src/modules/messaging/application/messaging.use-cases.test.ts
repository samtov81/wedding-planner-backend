import { ConversationRepositoryEnMemoria } from '../infrastructure/conversation.repository.fake'
import {
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
  MensajeInvalidoError,
  ParNoPermitidoError,
  SinAccesoAlEventoError,
} from '../domain/messaging-errors'
import { ListConversationsUseCase } from './list-conversations.use-case'
import { ListMessagesUseCase } from './list-messages.use-case'
import { MarkConversationUseCase } from './mark-conversation.use-case'
import { OpenConversationUseCase } from './open-conversation.use-case'
import { SendMessageUseCase } from './send-message.use-case'

const EVENTO = 'e1'
const PAREJA = 'u-pareja'
const PLANNER = 'u-planner'
const PROV_A = 'u-prov-a'
const PROV_B = 'u-prov-b'
const ADMIN = 'u-admin'

function escenario() {
  const repo = new ConversationRepositoryEnMemoria()
  repo.registrarEvento(EVENTO, 'Boda')
  repo.fijarPublicado(EVENTO, true)
  repo.registrarMiembro(EVENTO, PAREJA, 'COUPLE', 'ACTIVE', 'Pareja')
  repo.registrarMiembro(EVENTO, PLANNER, 'PLANNER', 'ACTIVE', 'Planner')
  repo.registrarProveedor(EVENTO, PROV_A, 'Foto A', true)
  repo.registrarProveedor(EVENTO, PROV_B, 'Flores B', true)
  return {
    repo,
    abrir: new OpenConversationUseCase(repo),
    enviar: new SendMessageUseCase(repo),
    marcar: new MarkConversationUseCase(repo),
    mensajes: new ListMessagesUseCase(repo),
    bandeja: new ListConversationsUseCase(repo),
  }
}

describe('casos de uso de mensajería', () => {
  describe('abrir', () => {
    it('proveedor con proveedor lanza ParNoPermitidoError', async () => {
      const { abrir } = escenario()
      await expect(abrir.ejecutar(PROV_A, EVENTO, PROV_B)).rejects.toBeInstanceOf(
        ParNoPermitidoError,
      )
    })

    it('abrir conmigo mismo lanza ParNoPermitidoError', async () => {
      const { abrir } = escenario()
      await expect(abrir.ejecutar(PAREJA, EVENTO, PAREJA)).rejects.toBeInstanceOf(
        ParNoPermitidoError,
      )
    })

    it('sin acceso al evento lanza SinAccesoAlEventoError', async () => {
      const { abrir } = escenario()
      await expect(abrir.ejecutar(ADMIN, EVENTO, PAREJA)).rejects.toBeInstanceOf(
        SinAccesoAlEventoError,
      )
    })

    it('con alguien sin acceso lanza ConversacionNoEncontradaError', async () => {
      const { abrir } = escenario()
      await expect(abrir.ejecutar(PAREJA, EVENTO, ADMIN)).rejects.toBeInstanceOf(
        ConversacionNoEncontradaError,
      )
    })

    it('abrir dos veces devuelve la misma: creada y luego no', async () => {
      const { abrir } = escenario()
      const una = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      const otra = await abrir.ejecutar(PROV_A, EVENTO, PAREJA)
      expect(una.creada).toBe(true)
      expect(otra.creada).toBe(false)
      expect(otra.conversacion.id).toBe(una.conversacion.id)
      expect(una.conversacion.other.userId).toBe(PROV_A)
    })
  })

  describe('enviar', () => {
    it('normaliza el cuerpo y devuelve el mensaje y los destinatarios', async () => {
      const { abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      const r = await enviar.ejecutar(PAREJA, conversacion.id, '  hola  ')
      expect(r.mensaje.body).toBe('hola')
      expect(r.mensaje.senderId).toBe(PAREJA)
      expect(r.destinatarios).toEqual([PROV_A])
    })

    it('un cuerpo vacío lanza MensajeInvalidoError', async () => {
      const { abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      await expect(enviar.ejecutar(PAREJA, conversacion.id, '   ')).rejects.toBeInstanceOf(
        MensajeInvalidoError,
      )
    })

    it('en solo lectura lanza ConversacionSoloLecturaError', async () => {
      const { repo, abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      repo.registrarProveedor(EVENTO, PROV_A, 'Foto A', false)
      await expect(enviar.ejecutar(PAREJA, conversacion.id, 'hola')).rejects.toBeInstanceOf(
        ConversacionSoloLecturaError,
      )
    })

    it('un no participante recibe ConversacionNoEncontradaError', async () => {
      const { abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      await expect(enviar.ejecutar(PROV_B, conversacion.id, 'hola')).rejects.toBeInstanceOf(
        ConversacionNoEncontradaError,
      )
    })
  })

  describe('marcar', () => {
    it('upTo de otra conversación lanza ConversacionNoEncontradaError', async () => {
      const { abrir, enviar, marcar } = escenario()
      const c1 = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
      const c2 = (await abrir.ejecutar(PAREJA, EVENTO, PLANNER)).conversacion
      const { mensaje } = await enviar.ejecutar(PAREJA, c1.id, 'hola')
      await expect(marcar.ejecutar(PLANNER, c2.id, 'read', mensaje.id)).rejects.toBeInstanceOf(
        ConversacionNoEncontradaError,
      )
    })

    it('marca leído y devuelve las marcas y los demás participantes', async () => {
      const { abrir, enviar, marcar, bandeja } = escenario()
      const c = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
      const { mensaje } = await enviar.ejecutar(PAREJA, c.id, 'hola')
      expect((await bandeja.ejecutar(PROV_A)).unreadTotal).toBe(1)
      const r = await marcar.ejecutar(PROV_A, c.id, 'read', mensaje.id)
      expect(r.marcas.readUpTo?.id).toBe(mensaje.id)
      expect(r.destinatarios).toEqual([PAREJA])
      expect((await bandeja.ejecutar(PROV_A)).unreadTotal).toBe(0)
    })

    it('se puede marcar en una conversación de solo lectura', async () => {
      const { repo, abrir, enviar, marcar } = escenario()
      const c = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
      const { mensaje } = await enviar.ejecutar(PAREJA, c.id, 'hola')
      repo.registrarMiembro(EVENTO, PAREJA, 'COUPLE', 'REVOKED', 'Pareja')
      repo.registrarMiembro(EVENTO, PLANNER, 'PLANNER', 'REVOKED', 'Planner')
      repo.registrarProveedor(EVENTO, PROV_A, 'Foto A', false)
      // PROV_A perdió el acceso: ya no la ve. La pareja revocada sí, en solo lectura.
      await expect(marcar.ejecutar(PROV_A, c.id, 'read', mensaje.id)).rejects.toBeInstanceOf(
        ConversacionNoEncontradaError,
      )
      const r = await marcar.ejecutar(PAREJA, c.id, 'read', mensaje.id)
      expect(r.marcas.readUpTo?.id).toBe(mensaje.id)
    })
  })

  describe('mensajes', () => {
    it('un no participante recibe ConversacionNoEncontradaError', async () => {
      const { abrir, mensajes } = escenario()
      const c = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
      await expect(
        mensajes.ejecutar(PROV_B, c.id, { desde: null, limite: 10 }),
      ).rejects.toBeInstanceOf(ConversacionNoEncontradaError)
    })
  })
})

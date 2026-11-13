import { Logger } from '@nestjs/common'

import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { SubidaDeAdjuntos } from '@/modules/storage/application/subida-de-adjuntos'
import { SubidaNoValidaError } from '@/modules/storage/domain/imagen'
import { ObjectStorageEnMemoria } from '@/modules/storage/infrastructure/object-storage.fake'

import { ConversationRepositoryEnMemoria } from '../infrastructure/conversation.repository.fake'
import {
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
  MensajeInvalidoError,
  NombreDeAdjuntoInvalidoError,
  ParNoPermitidoError,
  SinAccesoAlEventoError,
} from '../domain/messaging-errors'
import { prefijoAdjuntos } from './adjuntos.use-cases'
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
  const cola = new InMemoryQueueAdapter()
  const almacen = new ObjectStorageEnMemoria()
  return {
    repo,
    cola,
    almacen,
    abrir: new OpenConversationUseCase(repo),
    enviar: new SendMessageUseCase(repo, cola, new SubidaDeAdjuntos(almacen)),
    marcar: new MarkConversationUseCase(repo, cola),
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
      const r = await enviar.ejecutar(PAREJA, conversacion.id, '  hola  ', null)
      expect(r.mensaje.body).toBe('hola')
      expect(r.mensaje.senderId).toBe(PAREJA)
      expect(r.destinatarios).toEqual([PROV_A])
    })

    it('encola tras persistir: el aviso lleva ids y el mensaje ya está guardado', async () => {
      const { repo, cola, abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      const { mensaje } = await enviar.ejecutar(PAREJA, conversacion.id, 'hola', null)
      expect(cola.encolados).toHaveLength(1)
      expect(cola.encolados[0]).toMatchObject({
        cola: 'messaging',
        nombre: 'message.created',
        datos: { conversationId: conversacion.id, messageId: mensaje.id },
        jobId: `message-${mensaje.id}`,
      })
      expect(await repo.mensaje(conversacion.id, mensaje.id)).not.toBeNull()
    })

    it('si encolar falla, el envío responde igual y se avisa con un warn', async () => {
      const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const { cola, abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      cola.enqueue = () => Promise.reject(new Error('redis caído'))
      await expect(enviar.ejecutar(PAREJA, conversacion.id, 'hola', null)).resolves.toMatchObject({
        mensaje: { body: 'hola' },
      })
      expect(aviso).toHaveBeenCalledOnce()
      expect(aviso).toHaveBeenCalledWith(
        expect.stringMatching(/^Mensaje guardado pero su aviso no se pudo encolar .*redis caído$/),
      )
      aviso.mockRestore()
    })

    it('un envío rechazado no encola nada', async () => {
      const { cola, abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      await expect(enviar.ejecutar(PAREJA, conversacion.id, '   ', null)).rejects.toBeInstanceOf(
        MensajeInvalidoError,
      )
      expect(cola.encolados).toEqual([])
    })

    it('un cuerpo vacío lanza MensajeInvalidoError', async () => {
      const { abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      await expect(enviar.ejecutar(PAREJA, conversacion.id, '   ', null)).rejects.toBeInstanceOf(
        MensajeInvalidoError,
      )
    })

    it('en solo lectura lanza ConversacionSoloLecturaError', async () => {
      const { repo, abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      repo.registrarProveedor(EVENTO, PROV_A, 'Foto A', false)
      await expect(enviar.ejecutar(PAREJA, conversacion.id, 'hola', null)).rejects.toBeInstanceOf(
        ConversacionSoloLecturaError,
      )
    })

    it('un no participante recibe ConversacionNoEncontradaError', async () => {
      const { abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      await expect(enviar.ejecutar(PROV_B, conversacion.id, 'hola', null)).rejects.toBeInstanceOf(
        ConversacionNoEncontradaError,
      )
    })
  })

  describe('enviar con adjunto', () => {
    it('con un archivo subido bajo su prefijo guarda el adjunto y un cuerpo vacío', async () => {
      const { almacen, abrir, enviar, repo } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      const key = `${prefijoAdjuntos(EVENTO, conversacion.id)}/a.pdf`
      almacen.simularSubida(key, 'application/pdf', 2048)

      const r = await enviar.ejecutar(PAREJA, conversacion.id, '   ', {
        key,
        name: '  presupuesto.pdf  ',
      })
      expect(r.mensaje.body).toBe('')
      expect(r.mensaje.attachment).toEqual({
        name: 'presupuesto.pdf',
        contentType: 'application/pdf',
        bytes: 2048,
      })
      expect(r.destinatarios).toEqual([PROV_A])
      expect(await repo.adjuntoDe(r.mensaje.id)).toMatchObject({ key, eventId: EVENTO })
    })

    it('con una key de otro prefijo es 422 INVALID_UPLOAD y no guarda nada', async () => {
      const { almacen, abrir, enviar, cola } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      const ajena = `${prefijoAdjuntos(EVENTO, 'otra-conversacion')}/a.pdf`
      almacen.simularSubida(ajena, 'application/pdf', 2048)

      const error: unknown = await enviar
        .ejecutar(PAREJA, conversacion.id, 'mira', { key: ajena, name: 'a.pdf' })
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(SubidaNoValidaError)
      expect(error).toMatchObject({ httpStatus: 422, code: 'INVALID_UPLOAD' })
      expect(cola.encolados).toEqual([])
    })

    it('un nombre con barras es NombreDeAdjuntoInvalidoError', async () => {
      const { almacen, abrir, enviar } = escenario()
      const { conversacion } = await abrir.ejecutar(PAREJA, EVENTO, PROV_A)
      const key = `${prefijoAdjuntos(EVENTO, conversacion.id)}/a.pdf`
      almacen.simularSubida(key, 'application/pdf', 2048)
      await expect(
        enviar.ejecutar(PAREJA, conversacion.id, '', { key, name: '../a.pdf' }),
      ).rejects.toBeInstanceOf(NombreDeAdjuntoInvalidoError)
    })
  })

  describe('marcar', () => {
    it('upTo de otra conversación lanza ConversacionNoEncontradaError', async () => {
      const { abrir, enviar, marcar } = escenario()
      const c1 = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
      const c2 = (await abrir.ejecutar(PAREJA, EVENTO, PLANNER)).conversacion
      const { mensaje } = await enviar.ejecutar(PAREJA, c1.id, 'hola', null)
      await expect(marcar.ejecutar(PLANNER, c2.id, 'read', mensaje.id)).rejects.toBeInstanceOf(
        ConversacionNoEncontradaError,
      )
    })

    it('marca leído y devuelve las marcas y los demás participantes', async () => {
      const { abrir, enviar, marcar, bandeja } = escenario()
      const c = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
      const { mensaje } = await enviar.ejecutar(PAREJA, c.id, 'hola', null)
      expect((await bandeja.ejecutar(PROV_A)).unreadTotal).toBe(1)
      const r = await marcar.ejecutar(PROV_A, c.id, 'read', mensaje.id)
      expect(r.marcas.readUpTo?.id).toBe(mensaje.id)
      expect(r.destinatarios).toEqual([PAREJA])
      expect((await bandeja.ejecutar(PROV_A)).unreadTotal).toBe(0)
    })

    it('encola el recibo tras persistir y, si encolar falla, responde igual', async () => {
      const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
      const { cola, abrir, enviar, marcar } = escenario()
      const c = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
      const { mensaje } = await enviar.ejecutar(PAREJA, c.id, 'hola', null)
      await marcar.ejecutar(PROV_A, c.id, 'read', mensaje.id)
      const recibo = cola.encolados.find((e) => e.nombre === 'message.receipt')
      expect(recibo).toMatchObject({
        cola: 'messaging',
        datos: { conversationId: c.id, userId: PROV_A },
      })
      expect(recibo?.jobId).toBe(`receipt-${c.id}-${PROV_A}-none-${mensaje.id}`)
      expect(recibo?.jobId).not.toContain(':')

      cola.enqueue = () => Promise.reject(new Error('redis caído'))
      await expect(marcar.ejecutar(PROV_A, c.id, 'read', mensaje.id)).resolves.toMatchObject({
        conversationId: c.id,
      })
      expect(aviso).toHaveBeenCalledWith(
        expect.stringMatching(/^Recibo guardado pero su aviso no se pudo encolar .*redis caído$/),
      )
      aviso.mockRestore()
    })

    it('el jobId del recibo sale del estado: entregado y leído en el mismo ms difieren', async () => {
      vi.useFakeTimers()
      try {
        const { cola, abrir, enviar, marcar } = escenario()
        const c = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
        const { mensaje } = await enviar.ejecutar(PAREJA, c.id, 'hola', null)
        await marcar.ejecutar(PROV_A, c.id, 'delivered', mensaje.id)
        await marcar.ejecutar(PROV_A, c.id, 'read', mensaje.id)
        await marcar.ejecutar(PROV_A, c.id, 'read', mensaje.id)
        const ids = cola.encolados.filter((e) => e.nombre === 'message.receipt').map((e) => e.jobId)
        // El tercero repite el estado del segundo: mismo jobId, la cola lo deduplica.
        expect(ids).toHaveLength(2)
        expect(ids[0]).not.toBe(ids[1])
      } finally {
        vi.useRealTimers()
      }
    })

    it('se puede marcar en una conversación de solo lectura', async () => {
      const { repo, abrir, enviar, marcar } = escenario()
      const c = (await abrir.ejecutar(PAREJA, EVENTO, PROV_A)).conversacion
      const { mensaje } = await enviar.ejecutar(PAREJA, c.id, 'hola', null)
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

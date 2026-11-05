import { Logger } from '@nestjs/common'

import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import { DomainError } from '@/shared/domain'

import { ConversationRepositoryEnMemoria } from '../infrastructure/conversation.repository.fake'
import {
  AutocontactoError,
  ConversacionNoEncontradaError,
  ConversacionSoloLecturaError,
  EscrituraEnSolicitudPendienteError,
  FichaNoDisponibleError,
  MensajeInvalidoError,
  SolicitudNoPendienteError,
} from '../domain/messaging-errors'
import { ESPERA_TRAS_RECHAZO_MS } from '../domain/perfil'
import type { FichaParaContacto } from './conversation.repository'
import { GetContactStateUseCase } from './get-contact-state.use-case'
import { ListMessagesUseCase } from './list-messages.use-case'
import { ListProfileConversationsUseCase } from './list-profile-conversations.use-case'
import { ListRoomReadersUseCase } from './list-room-readers.use-case'
import { MarkConversationUseCase } from './mark-conversation.use-case'
import { RequestContactUseCase } from './request-contact.use-case'
import { RespondContactUseCase } from './respond-contact.use-case'
import { SendMessageUseCase } from './send-message.use-case'

const PEDIDOR = 'u-pedidor'
const PROV = 'u-prov'

function escenario(publicada = true) {
  const repo = new ConversationRepositoryEnMemoria()
  repo.registrarUsuario(PEDIDOR, 'Ana')
  const ficha = repo.sembrarFicha(PROV, { businessName: 'Foto Sol', publicada })
  const cola = new InMemoryQueueAdapter()
  return {
    repo,
    cola,
    ficha,
    pedir: new RequestContactUseCase(repo, cola),
    responder: new RespondContactUseCase(repo, cola),
    estado: new GetContactStateUseCase(repo),
    lista: new ListProfileConversationsUseCase(repo),
    enviar: new SendMessageUseCase(repo, cola),
    mensajes: new ListMessagesUseCase(repo),
    marcar: new MarkConversationUseCase(repo, cola),
    lectores: new ListRoomReadersUseCase(repo),
  }
}

/** La ficha sembrada tal como la lee el caso de uso (para llamar a `solicitar` a mano). */
async function fichaSembrada(
  repo: ConversationRepositoryEnMemoria,
  id: string,
): Promise<FichaParaContacto> {
  const ficha = await repo.fichaParaContacto(id)
  if (ficha === null) throw new Error(`ficha ${id} sin sembrar`)
  return ficha
}

/** Hace 24 h y un minuto: un rechazo así ya permite volver a pedir. */
const haceMasDeUnDia = (): Date => new Date(Date.now() - ESPERA_TRAS_RECHAZO_MS - 60_000)

describe('casos de uso del contacto desde la ficha', () => {
  it('una ficha en borrador es un 404', async () => {
    const { pedir, ficha } = escenario(false)
    await expect(pedir.ejecutar(PEDIDOR, ficha, 'hola')).rejects.toBeInstanceOf(
      FichaNoDisponibleError,
    )
  })

  it('el dueño de la ficha no puede contactarse (422)', async () => {
    const { pedir, ficha } = escenario()
    await expect(pedir.ejecutar(PROV, ficha, 'hola')).rejects.toBeInstanceOf(AutocontactoError)
  })

  it('un cuerpo de espacios falla y no deja conversación', async () => {
    const { pedir, lista, ficha } = escenario()
    await expect(pedir.ejecutar(PEDIDOR, ficha, '   ')).rejects.toBeInstanceOf(MensajeInvalidoError)
    expect((await lista.ejecutar(PEDIDOR)).items).toEqual([])
  })

  it('pedir crea la solicitud PENDING y encola message.created y contact.updated', async () => {
    const { pedir, cola, ficha } = escenario()
    const r = await pedir.ejecutar(PEDIDOR, ficha, '  hola  ')
    expect(r.mensaje.body).toBe('hola')
    expect(r.conversacion).toMatchObject({ status: 'PENDING', direction: 'SENT', readOnly: true })
    expect(cola.encolados.map((j) => j.nombre)).toEqual(['message.created', 'contact.updated'])
    expect(cola.encolados[1]?.datos).toEqual({
      conversationId: r.conversacion.id,
      estado: 'PENDING',
      mensajeId: r.mensaje.id,
    })
  })

  it('el solicitante no escribe en PENDING (403 CONTACT_REQUEST_PENDING)', async () => {
    const { pedir, enviar, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await expect(enviar.ejecutar(PEDIDOR, conversacion.id, 'otro')).rejects.toBeInstanceOf(
      EscrituraEnSolicitudPendienteError,
    )
  })

  it('el proveedor tampoco escribe en PENDING', async () => {
    const { pedir, enviar, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await expect(enviar.ejecutar(PROV, conversacion.id, 'otro')).rejects.toBeInstanceOf(
      EscrituraEnSolicitudPendienteError,
    )
  })

  it('tras aceptar escriben los dos; responder sólo encola contact.updated', async () => {
    const { pedir, responder, enviar, cola, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    cola.encolados.length = 0
    const vista = await responder.ejecutar(PROV, conversacion.id, 'ACCEPTED')
    expect(vista).toMatchObject({ status: 'ACCEPTED', direction: 'RECEIVED', readOnly: false })
    expect(cola.encolados.map((j) => j.nombre)).toEqual(['contact.updated'])
    expect(cola.encolados[0]?.datos).toEqual({
      conversationId: conversacion.id,
      estado: 'ACCEPTED',
      mensajeId: null,
    })

    const m1 = await enviar.ejecutar(PEDIDOR, conversacion.id, 'gracias')
    expect(m1.destinatarios).toEqual([PROV])
    const m2 = await enviar.ejecutar(PROV, conversacion.id, 'a ti')
    expect(m2.destinatarios).toEqual([PEDIDOR])
  })

  it('responder dos veces es SolicitudNoPendienteError; un ajeno, 404', async () => {
    const { pedir, responder, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await expect(responder.ejecutar(PEDIDOR, conversacion.id, 'ACCEPTED')).rejects.toBeInstanceOf(
      ConversacionNoEncontradaError,
    )
    await responder.ejecutar(PROV, conversacion.id, 'ACCEPTED')
    await expect(responder.ejecutar(PROV, conversacion.id, 'DECLINED')).rejects.toBeInstanceOf(
      SolicitudNoPendienteError,
    )
  })

  it('quien ya rechazó y vuelve a responder recibe SolicitudNoPendienteError, no 404', async () => {
    const { pedir, responder, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await responder.ejecutar(PROV, conversacion.id, 'DECLINED')
    for (const decision of ['ACCEPTED', 'DECLINED'] as const) {
      await expect(responder.ejecutar(PROV, conversacion.id, decision)).rejects.toBeInstanceOf(
        SolicitudNoPendienteError,
      )
    }
  })

  it('en DECLINED el solicitante la ve pero no escribe; el proveedor no la localiza', async () => {
    const { pedir, responder, enviar, mensajes, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    const vista = await responder.ejecutar(PROV, conversacion.id, 'DECLINED')
    expect(vista).toMatchObject({ status: 'DECLINED', readOnly: true })

    await expect(enviar.ejecutar(PEDIDOR, conversacion.id, 'x')).rejects.toBeInstanceOf(
      ConversacionSoloLecturaError,
    )
    const pagina = await mensajes.ejecutar(PEDIDOR, conversacion.id, { desde: null, limite: 50 })
    expect(pagina.tipo).toBe('directa')
    await expect(enviar.ejecutar(PROV, conversacion.id, 'x')).rejects.toBeInstanceOf(
      ConversacionNoEncontradaError,
    )
    await expect(
      mensajes.ejecutar(PROV, conversacion.id, { desde: null, limite: 50 }),
    ).rejects.toBeInstanceOf(ConversacionNoEncontradaError)
  })

  it('listar mensajes y marcar tratan el perfil como una 1:1', async () => {
    const { pedir, mensajes, marcar, ficha } = escenario()
    const { conversacion, mensaje } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    const pagina = await mensajes.ejecutar(PROV, conversacion.id, { desde: null, limite: 50 })
    expect(pagina.tipo).toBe('directa')
    expect(pagina.pagina.items.map((m) => m.id)).toEqual([mensaje.id])
    const r = await marcar.ejecutar(PROV, conversacion.id, 'read', mensaje.id)
    expect(r.destinatarios).toEqual([PEDIDOR])
  })

  it('el estado GET con la ficha despublicada y el par aceptado es ACCEPTED', async () => {
    const { pedir, responder, estado, repo, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await responder.ejecutar(PROV, conversacion.id, 'ACCEPTED')
    repo.sembrarFicha(PROV, { businessName: 'Foto Sol', publicada: false })
    expect(await estado.ejecutar(PEDIDOR, ficha)).toEqual({
      state: 'ACCEPTED',
      conversationId: conversacion.id,
      retryAt: null,
    })
  })

  it('el estado GET con la ficha despublicada y sin par es un 404', async () => {
    const { estado, ficha } = escenario(false)
    await expect(estado.ejecutar(PEDIDOR, ficha)).rejects.toBeInstanceOf(FichaNoDisponibleError)
    await expect(estado.ejecutar(PEDIDOR, 'no-existe')).rejects.toBeInstanceOf(
      FichaNoDisponibleError,
    )
  })

  it('el estado GET sin par es NONE y con la propia ficha SELF', async () => {
    const { estado, ficha } = escenario()
    expect(await estado.ejecutar(PEDIDOR, ficha)).toMatchObject({ state: 'NONE' })
    expect(await estado.ejecutar(PROV, ficha)).toMatchObject({ state: 'SELF' })
  })

  it('readers sobre una conversación de perfil es un 404', async () => {
    const { pedir, lectores, ficha } = escenario()
    const { conversacion, mensaje } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await expect(lectores.ejecutar(PEDIDOR, conversacion.id, mensaje.id)).rejects.toBeInstanceOf(
      ConversacionNoEncontradaError,
    )
  })

  it('carrera: el proveedor que rechazó responde mientras el solicitante reintenta → acepta la nueva y encola', async () => {
    const { pedir, responder, repo, cola, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await repo.responder(conversacion.id, PROV, 'DECLINED', haceMasDeUnDia())
    // El reintento del solicitante entra justo antes de que `responder` bloquee
    // la fila: lo que el proveedor ve antes (nada: la rechazó) ya no vale.
    const original = repo.responder.bind(repo)
    vi.spyOn(repo, 'responder').mockImplementationOnce(async (...args) => {
      await repo.solicitar({
        solicitante: PEDIDOR,
        ficha: await fichaSembrada(repo, ficha),
        cuerpo: 'otra vez',
        relacionados: false,
        // Un segundo después de 'hola': en el mismo milisegundo el orden lo decidiría el id.
        ahora: new Date(Date.now() + 1_000),
      })
      return await original(...args)
    })
    cola.encolados.length = 0

    const vista = await responder.ejecutar(PROV, conversacion.id, 'ACCEPTED')

    expect(vista).toMatchObject({
      id: conversacion.id,
      status: 'ACCEPTED',
      direction: 'RECEIVED',
      readOnly: false,
      lastMessage: { body: 'otra vez' },
    })
    expect(cola.encolados.map((j) => [j.nombre, j.datos])).toEqual([
      ['contact.updated', { conversationId: conversacion.id, estado: 'ACCEPTED', mensajeId: null }],
    ])
  })

  it('rechazar devuelve la vista del proveedor en solo lectura y encola contact.updated', async () => {
    const { pedir, responder, cola, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    cola.encolados.length = 0
    const vista = await responder.ejecutar(PROV, conversacion.id, 'DECLINED')
    expect(vista).toMatchObject({
      id: conversacion.id,
      status: 'DECLINED',
      direction: 'RECEIVED',
      readOnly: true,
      retryAt: null,
      other: { userId: PEDIDOR, displayName: 'Ana', role: 'CONTACT' },
      lastMessage: { body: 'hola' },
    })
    expect(cola.encolados.map((j) => j.nombre)).toEqual(['contact.updated'])
  })

  it('si la vista desaparece tras solicitar, los avisos ya están encolados y el error es de invariante (no 404)', async () => {
    const { pedir, repo, cola, ficha } = escenario()
    vi.spyOn(repo, 'buscarPerfil').mockResolvedValue(null)
    const intento = pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await expect(intento).rejects.toThrow(/invariante/)
    await expect(intento).rejects.not.toBeInstanceOf(DomainError)
    expect(cola.encolados.map((j) => j.nombre)).toEqual(['message.created', 'contact.updated'])
    expect(cola.encolados[1]?.datos).toMatchObject({ estado: 'PENDING' })
  })

  it('si encolar falla, pedir responde igual (y avisa con un warn)', async () => {
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { pedir, cola, ficha } = escenario()
    cola.enqueue = () => Promise.reject(new Error('redis caído'))
    const r = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    expect(r.conversacion).toMatchObject({ status: 'PENDING', direction: 'SENT', readOnly: true })
    expect(r.mensaje.body).toBe('hola')
    expect(aviso).toHaveBeenCalledTimes(2)
    aviso.mockRestore()
  })

  it('si encolar falla, responder responde igual (y avisa con un warn)', async () => {
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const { pedir, responder, cola, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    cola.enqueue = () => Promise.reject(new Error('redis caído'))
    const vista = await responder.ejecutar(PROV, conversacion.id, 'ACCEPTED')
    expect(vista).toMatchObject({ status: 'ACCEPTED', direction: 'RECEIVED', readOnly: false })
    expect(aviso).toHaveBeenCalledOnce()
    aviso.mockRestore()
  })

  it('el estado GET tras rechazar: DECLINED con retryAt para el solicitante', async () => {
    const { pedir, responder, estado, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await responder.ejecutar(PROV, conversacion.id, 'DECLINED')
    const r = await estado.ejecutar(PEDIDOR, ficha)
    expect(r).toMatchObject({ state: 'DECLINED', conversationId: conversacion.id })
    expect(r.retryAt).toBeInstanceOf(Date)
  })

  it('el estado GET tras aceptar es ACCEPTED con el id de la conversación', async () => {
    const { pedir, responder, estado, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    await responder.ejecutar(PROV, conversacion.id, 'ACCEPTED')
    expect(await estado.ejecutar(PEDIDOR, ficha)).toEqual({
      state: 'ACCEPTED',
      conversationId: conversacion.id,
      retryAt: null,
    })
  })

  it('el estado GET con la ficha despublicada y una pendiente es PENDING_SENT', async () => {
    const { pedir, estado, repo, ficha } = escenario()
    const { conversacion } = await pedir.ejecutar(PEDIDOR, ficha, 'hola')
    repo.sembrarFicha(PROV, { businessName: 'Foto Sol', publicada: false })
    expect(await estado.ejecutar(PEDIDOR, ficha)).toEqual({
      state: 'PENDING_SENT',
      conversationId: conversacion.id,
      retryAt: null,
    })
  })
})

describe('doble de ConversationRepository', () => {
  it('una conversación de perfil con una ficha no sembrada es null, como en Prisma', async () => {
    const repo = new ConversationRepositoryEnMemoria()
    repo.registrarUsuario(PEDIDOR, 'Ana')
    const ficha: FichaParaContacto = {
      id: 'ficha-sin-sembrar',
      userId: PROV,
      businessName: 'Nadie',
      publicada: true,
    }
    const { conversationId } = await repo.solicitar({
      solicitante: PEDIDOR,
      ficha,
      cuerpo: 'hola',
      relacionados: false,
      ahora: new Date(),
    })
    expect(await repo.parDePerfil(PEDIDOR, PROV)).toBeNull()
    expect(await repo.buscarPerfil(conversationId, PEDIDOR)).toBeNull()
    expect((await repo.perfiles(PEDIDOR)).items).toEqual([])
  })
})

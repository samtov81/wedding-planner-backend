import { Body, Controller, Get, HttpCode, Param, Post, Query, Res, UseGuards } from '@nestjs/common'
import type { Response } from 'express'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { decodeCursor, NotFoundError, UnauthorizedError } from '@/shared/domain'
import { LIMITADOR_MESSAGES, LimiteDeRuta } from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import type {
  Contacto,
  ConversacionVista,
  MarcasDeParticipante,
  MensajeVista,
} from '../application/conversation.repository'
import { ListContactsUseCase } from '../application/list-contacts.use-case'
import { ListConversationsUseCase } from '../application/list-conversations.use-case'
import { ListMessagesUseCase } from '../application/list-messages.use-case'
import { MarkConversationUseCase } from '../application/mark-conversation.use-case'
import { OpenConversationUseCase } from '../application/open-conversation.use-case'
import { SendMessageUseCase } from '../application/send-message.use-case'
import { ConversacionNoEncontradaError } from '../domain/messaging-errors'
import type { Marca } from '../domain/conversacion'
import {
  abrirConversacionSchema,
  enviarMensajeSchema,
  idSchema,
  listarMensajesQuerySchema,
  marcarSchema,
} from './messaging.dto'

interface MarcaJson {
  at: string
  id: string
}

interface MensajeJson {
  id: string
  conversationId: string
  senderId: string
  body: string
  createdAt: string
}

interface OtherMarksJson {
  deliveredUpTo: MarcaJson | null
  readUpTo: MarcaJson | null
}

interface ConversacionJson {
  id: string
  event: { id: string; name: string }
  other: Contacto
  lastMessage: MensajeJson | null
  unreadCount: number
  readOnly: boolean
  otherMarks: OtherMarksJson
}

const marcaJson = (m: Marca | null): MarcaJson | null =>
  m === null ? null : { at: m.at.toISOString(), id: m.id }

const otherMarksJson = (m: MarcasDeParticipante): OtherMarksJson => ({
  deliveredUpTo: marcaJson(m.deliveredUpTo),
  readUpTo: marcaJson(m.readUpTo),
})

const mensajeJson = (m: MensajeVista): MensajeJson => ({
  id: m.id,
  conversationId: m.conversationId,
  senderId: m.senderId,
  body: m.body,
  createdAt: m.createdAt.toISOString(),
})

const conversacionJson = (c: ConversacionVista): ConversacionJson => ({
  id: c.id,
  event: c.event,
  other: c.other,
  lastMessage: c.lastMessage === null ? null : mensajeJson(c.lastMessage),
  unreadCount: c.unreadCount,
  readOnly: c.readOnly,
  otherMarks: otherMarksJson(c.otherMarks),
})

/**
 * Mensajería 1:1 dentro de un evento (parte 1: sólo REST).
 *
 * Sólo `JwtAuthGuard`, SIN `EventAccessGuard`, a propósito: la regla de acceso
 * de mensajería difiere de la del resto del evento. Un administrador del
 * sistema NO entra (el guard de eventos le da acceso de administrador), un
 * proveedor sólo cuenta si está BOOKED en un evento PUBLICADO, y una
 * conversación que ya no se puede escribir sigue siendo legible. Esa regla
 * vive en el repositorio (`rolEnEvento`, `buscar`) para que haya un único sitio
 * que la decida; ponerle encima el guard de eventos añadiría una segunda
 * regla que contradice a la primera.
 *
 * Un id con forma inválida responde 404 (no 500 por un P2023 de Prisma), igual
 * que `NotificationsController`. Sin acceso a una conversación ajena también
 * es 404: no confirma que exista. Sólo el envío lleva límite propio
 * (`messages`, 30/min); el resto se queda con el global.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class ConversationsController {
  constructor(
    private readonly bandeja: ListConversationsUseCase,
    private readonly contactos: ListContactsUseCase,
    private readonly abrir: OpenConversationUseCase,
    private readonly mensajes: ListMessagesUseCase,
    private readonly enviar: SendMessageUseCase,
    private readonly marcar: MarkConversationUseCase,
  ) {}

  @Get('me/conversations')
  async miBandeja(@CurrentUser() usuario: UsuarioAutenticado | undefined): Promise<{
    items: ConversacionJson[]
    unreadTotal: number
  }> {
    const r = await this.bandeja.ejecutar(exigirUsuario(usuario).id)
    return { items: r.items.map(conversacionJson), unreadTotal: r.unreadTotal }
  }

  @Get('events/:eventId/contacts')
  async contactosDelEvento(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
  ): Promise<{ items: Contacto[] }> {
    const yo = exigirUsuario(usuario)
    return { items: await this.contactos.ejecutar(yo.id, idDeEvento(eventId)) }
  }

  /** 201 si la crea, 200 si ya existía. */
  @Post('events/:eventId/conversations')
  async abrirConversacion(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('eventId') eventId: string,
    @Body() cuerpo: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ConversacionJson> {
    const yo = exigirUsuario(usuario)
    const { userId } = validarCon(abrirConversacionSchema, cuerpo)
    const r = await this.abrir.ejecutar(yo.id, idDeEvento(eventId), userId)
    res.status(r.creada ? 201 : 200)
    return conversacionJson(r.conversacion)
  }

  @Get('conversations/:id/messages')
  async listarMensajes(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<{ items: MensajeJson[]; nextCursor: string | null; otherMarks: OtherMarksJson }> {
    const yo = exigirUsuario(usuario)
    const { cursor, limit } = validarCon(listarMensajesQuerySchema, query)
    const r = await this.mensajes.ejecutar(yo.id, idDeConversacion(id), {
      desde: cursor === undefined ? null : decodeCursor(cursor),
      limite: limit,
    })
    return {
      items: r.pagina.items.map(mensajeJson),
      nextCursor: r.pagina.nextCursor,
      otherMarks: otherMarksJson(r.otherMarks),
    }
  }

  @Post('conversations/:id/messages')
  @LimiteDeRuta(LIMITADOR_MESSAGES, { ttl: 60_000, limit: 30 })
  async enviarMensaje(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('id') id: string,
    @Body() cuerpo: unknown,
  ): Promise<MensajeJson> {
    const yo = exigirUsuario(usuario)
    const { body } = validarCon(enviarMensajeSchema, cuerpo)
    const r = await this.enviar.ejecutar(yo.id, idDeConversacion(id), body)
    return mensajeJson(r.mensaje)
  }

  @Post('conversations/:id/delivered')
  @HttpCode(204)
  async entregado(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('id') id: string,
    @Body() cuerpo: unknown,
  ): Promise<void> {
    const yo = exigirUsuario(usuario)
    const { upTo } = validarCon(marcarSchema, cuerpo)
    await this.marcar.ejecutar(yo.id, idDeConversacion(id), 'delivered', upTo)
  }

  @Post('conversations/:id/read')
  @HttpCode(204)
  async leido(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('id') id: string,
    @Body() cuerpo: unknown,
  ): Promise<void> {
    const yo = exigirUsuario(usuario)
    const { upTo } = validarCon(marcarSchema, cuerpo)
    await this.marcar.ejecutar(yo.id, idDeConversacion(id), 'read', upTo)
  }
}

function idDeConversacion(id: string): string {
  if (!idSchema.safeParse(id).success) throw new ConversacionNoEncontradaError()
  return id
}

function idDeEvento(id: string): string {
  if (!idSchema.safeParse(id).success) throw new NotFoundError('El evento no existe')
  return id
}

function exigirUsuario(usuario: UsuarioAutenticado | undefined): UsuarioAutenticado {
  if (usuario === undefined) throw new UnauthorizedError('Falta el token de acceso')
  return usuario
}

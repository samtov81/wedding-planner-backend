import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common'

import {
  CurrentUser,
  type UsuarioAutenticado,
} from '@/modules/auth/interfaces/current-user.decorator'
import { JwtAuthGuard } from '@/modules/auth/interfaces/jwt-auth.guard'
import { idDeRuta } from '@/shared/http/id-de-ruta'
import { LIMITE_CONTACT_REQUESTS, LimitePorUsuario } from '@/shared/http/limite-por-usuario'
import { validarCon } from '@/shared/http/validar-con'

import { GetContactStateUseCase } from '../application/get-contact-state.use-case'
import { ListProfileConversationsUseCase } from '../application/list-profile-conversations.use-case'
import { RequestContactUseCase } from '../application/request-contact.use-case'
import { RespondContactUseCase } from '../application/respond-contact.use-case'
import { ConversacionNoEncontradaError, FichaNoDisponibleError } from '../domain/messaging-errors'
import { exigirUsuario } from './exigir-usuario'
import { enviarMensajeSchema } from './messaging.dto'
import {
  conversacionDePerfilJson,
  mensajeJson,
  type ConversacionDePerfilJson,
  type MensajeJson,
} from './messaging.json'

/**
 * Contacto desde la ficha pública de un proveedor (parte 3). Aparte de
 * `ConversationsController` porque su límite y su vocabulario (ficha, no
 * evento) son otros; los mensajes de la conversación una vez aceptada siguen
 * por las rutas `conversations/:id/...` de siempre.
 *
 * `JwtAuthGuard` va a nivel de CLASE a propósito: corre antes que el
 * `LimitePorUsuarioGuard` del método, que necesita `req.user`. Un id de ruta
 * que no es UUID responde el mismo 404 que uno inexistente (`idDeRuta`), nunca
 * un 500 por el cast `::uuid` del adaptador de Prisma.
 */
@UseGuards(JwtAuthGuard)
@Controller()
export class ContactRequestsController {
  constructor(
    private readonly estado: GetContactStateUseCase,
    private readonly solicitar: RequestContactUseCase,
    private readonly responder: RespondContactUseCase,
    private readonly perfiles: ListProfileConversationsUseCase,
  ) {}

  @Get('vendors/:vendorId/contact')
  async estadoDeContacto(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('vendorId') vendorId: string,
  ): Promise<{ state: string; conversationId: string | null; retryAt: string | null }> {
    const yo = exigirUsuario(usuario)
    const r = await this.estado.ejecutar(yo.id, idDeFicha(vendorId))
    return {
      state: r.state,
      conversationId: r.conversationId,
      retryAt: r.retryAt === null ? null : r.retryAt.toISOString(),
    }
  }

  /** 201 por defecto de `@Post`. Cuenta contra el cupo aunque luego falle (404/409/422). */
  @Post('vendors/:vendorId/contact')
  @LimitePorUsuario(LIMITE_CONTACT_REQUESTS, { limit: 10, ttl: 3_600_000 })
  async pedirContacto(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('vendorId') vendorId: string,
    @Body() cuerpo: unknown,
  ): Promise<{ conversation: ConversacionDePerfilJson; message: MensajeJson }> {
    const yo = exigirUsuario(usuario)
    const { body } = validarCon(enviarMensajeSchema, cuerpo)
    const r = await this.solicitar.ejecutar(yo.id, idDeFicha(vendorId), body)
    return {
      conversation: conversacionDePerfilJson(r.conversacion),
      message: mensajeJson(r.mensaje),
    }
  }

  @Post('conversations/:id/accept')
  @HttpCode(200)
  async aceptar(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('id') id: string,
  ): Promise<ConversacionDePerfilJson> {
    const yo = exigirUsuario(usuario)
    return conversacionDePerfilJson(
      await this.responder.ejecutar(yo.id, idDeConversacion(id), 'ACCEPTED'),
    )
  }

  @Post('conversations/:id/decline')
  @HttpCode(200)
  async rechazar(
    @CurrentUser() usuario: UsuarioAutenticado | undefined,
    @Param('id') id: string,
  ): Promise<ConversacionDePerfilJson> {
    const yo = exigirUsuario(usuario)
    return conversacionDePerfilJson(
      await this.responder.ejecutar(yo.id, idDeConversacion(id), 'DECLINED'),
    )
  }

  @Get('me/profile-conversations')
  async misContactos(@CurrentUser() usuario: UsuarioAutenticado | undefined): Promise<{
    items: ConversacionDePerfilJson[]
    requestsPending: number
    unreadTotal: number
  }> {
    const r = await this.perfiles.ejecutar(exigirUsuario(usuario).id)
    return {
      items: r.items.map(conversacionDePerfilJson),
      requestsPending: r.requestsPending,
      unreadTotal: r.unreadTotal,
    }
  }
}

const idDeFicha = (id: string): string => idDeRuta(id, () => new FichaNoDisponibleError())
const idDeConversacion = (id: string): string =>
  idDeRuta(id, () => new ConversacionNoEncontradaError())

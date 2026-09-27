import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import {
  LIMITADOR_FORGOT_PASSWORD,
  LIMITADOR_LOGIN,
  LIMITADOR_REGISTER,
  LIMITADOR_RESEND_VERIFICATION,
  LIMITADOR_RESET_PASSWORD,
  LIMITADOR_VERIFY_EMAIL,
  LimiteDeRuta,
} from '@/shared/http/limitadores'
import { validarCon } from '@/shared/http/validar-con'

import { ForgotPasswordUseCase } from '../application/forgot-password.use-case'
import { LoginUseCase } from '../application/login.use-case'
import { LogoutUseCase } from '../application/logout.use-case'
import { RefreshUseCase } from '../application/refresh.use-case'
import { RegisterUseCase } from '../application/register.use-case'
import { ResendVerificationUseCase } from '../application/resend-verification.use-case'
import { ResetPasswordUseCase } from '../application/reset-password.use-case'
import { VerifyEmailUseCase } from '../application/verify-email.use-case'
import { RefreshInvalidoError } from '../domain/token-errors'
import {
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from './auth.dto'
import { CurrentUser, type UsuarioAutenticado } from './current-user.decorator'
import { JwtAuthGuard } from './jwt-auth.guard'

const COOKIE_REFRESH = 'wp_refresh'

@Controller('auth')
export class AuthController {
  constructor(
    private readonly registerUseCase: RegisterUseCase,
    private readonly loginUseCase: LoginUseCase,
    private readonly refreshUseCase: RefreshUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly verifyEmailUseCase: VerifyEmailUseCase,
    private readonly resendVerificationUseCase: ResendVerificationUseCase,
    private readonly forgotPasswordUseCase: ForgotPasswordUseCase,
    private readonly resetPasswordUseCase: ResetPasswordUseCase,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * Registro con verificación de email. Responde 201 en ambos casos: email
   * nuevo (crea usuario + encola verificación) o email ya registrado (encola
   * notificación de intento, sin crear usuario). La respuesta es idéntica en
   * ambas ramas — por tanto, no enumera cuentas por el status code. Ver
   * `RegisterUseCase` para los detalles de timing-equalization.
   */
  @Post('register')
  @HttpCode(201)
  @LimiteDeRuta(LIMITADOR_REGISTER, { limit: 5, ttl: 900_000, getTracker: rastreoPorIpYCorreo })
  async register(@Body() body: unknown): Promise<{ id: string; email: string; fullName: string }> {
    const datos = validarCon(registerSchema, body)
    return await this.registerUseCase.ejecutar(datos)
  }

  /**
   * Consumir un token de verificación de email. Un solo uso: al consumirse,
   * se marca CONSUMED. Llamadas posteriores con el mismo token devuelven
   * outcome='already_verified' (amigable, no error).
   *
   * Límite: 10/15min por IP. Generous — 32 bytes aleatorios hacen inviable
   * brute force. Existe para higiene/logging, no como defensa real.
   */
  @Post('verify-email')
  @HttpCode(200)
  @LimiteDeRuta(LIMITADOR_VERIFY_EMAIL, { limit: 10, ttl: 900_000 })
  async verifyEmail(@Body() body: unknown): Promise<{ outcome: string }> {
    const { token } = validarCon(verifyEmailSchema, body)
    return await this.verifyEmailUseCase.ejecutar(token)
  }

  /**
   * Límite: 5 intentos cada 15 minutos por IP + correo, contados en Redis,
   * ADEMÁS del global de 120/min por IP de toda la API (ruling C22), que es el
   * que acota a una IP que prueba muchos correos (password spraying).
   *
   * La clave es la PAREJA (IP, correo), no una de las dos: sólo por IP, quien
   * comparte IP con una oficina entera bloquearía el login de todos; sólo por
   * correo, cualquiera podría bloquear a propósito a un usuario legítimo.
   *
   * DESIGN-GAP: el brief argumenta además que limitar sólo por IP "deja pasar
   * el ataque distribuido contra una cuenta concreta". La clave compuesta
   * (ni el global por IP) tampoco lo para — cada IP del atacante estrena sus 5 intentos contra esa
   * cuenta. Pararlo exige un segundo límite por cuenta, más alto, que vuelve a
   * abrir el bloqueo a propósito. Es una decisión de producto que no se toma
   * aquí; lo que queda es el límite que el brief pide.
   */
  @Post('login')
  @HttpCode(200)
  @LimiteDeRuta(LIMITADOR_LOGIN, { limit: 5, ttl: 900_000, getTracker: rastreoPorIpYCorreo })
  async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const datos = validarCon(loginSchema, body)
    // El origen se captura aquí, que es el único sitio que lo conoce, y se
    // guarda con la sesión: cuando salte la detección de reuso hay que poder
    // decir desde qué IP y qué dispositivo nació esa familia.
    const { accessToken, refreshToken } = await this.loginUseCase.ejecutar({
      ...datos,
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    })
    this.ponerCookieRefresh(res, refreshToken)
    return { accessToken }
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ accessToken: string }> {
    const tokenActual = this.leerCookieRefresh(req)
    const { accessToken, refreshToken } = await this.refreshUseCase.ejecutar(tokenActual)
    this.ponerCookieRefresh(res, refreshToken)
    return { accessToken }
  }

  @Post('logout')
  @HttpCode(200)
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ ok: true }> {
    const token = this.leerCookieRefreshOpcional(req)
    // eslint-disable-next-line security/detect-possible-timing-attacks -- no se compara un secreto: sólo se mira si la cookie venía o no
    if (token !== undefined) await this.logoutUseCase.ejecutar(token)
    res.clearCookie(COOKIE_REFRESH, { path: '/auth' })
    return { ok: true }
  }

  /**
   * Reenvío del correo de verificación. Responde 202 y el mismo cuerpo SIEMPRE:
   * exista la cuenta, esté ya verificada o no exista. El caso de uso devuelve
   * `void` justo para que aquí no haya nada que contar — cualquier diferencia
   * visible convertiría esto en un enumerador de cuentas.
   *
   * 3 por hora por IP+correo: sin límite, el endpoint es un cañón de correo
   * gratis contra la dirección de cualquiera y quema la reputación de envío del
   * dominio. Misma clave compuesta que el login.
   */
  @Post('resend-verification')
  @HttpCode(202)
  @LimiteDeRuta(LIMITADOR_RESEND_VERIFICATION, {
    limit: 3,
    ttl: 3_600_000,
    getTracker: rastreoPorIpYCorreo,
  })
  async resendVerification(@Body() body: unknown): Promise<{ ok: true }> {
    const datos = validarCon(resendVerificationSchema, body)
    await this.resendVerificationUseCase.ejecutar(datos)
    return { ok: true }
  }

  /**
   * Pedir el enlace de recuperación. 202 y el mismo cuerpo SIEMPRE, exista la
   * cuenta o no: cualquier diferencia enumeraría cuentas. 3 por hora por
   * IP+correo: sin límite es un cañón de correo contra cualquier dirección.
   */
  @Post('forgot-password')
  @HttpCode(202)
  @LimiteDeRuta(LIMITADOR_FORGOT_PASSWORD, { limit: 3, ttl: 3_600_000, getTracker: rastreoPorIpYCorreo })
  async forgotPassword(@Body() body: unknown): Promise<{ ok: true }> {
    const datos = validarCon(forgotPasswordSchema, body)
    await this.forgotPasswordUseCase.ejecutar(datos)
    return { ok: true }
  }

  /**
   * Fijar la contraseña nueva con el token del correo. No abre sesión ni toca
   * la cookie: el usuario vuelve al login. 10 cada 15 min por IP: el token de
   * 32 bytes ya hace inviable adivinarlo; el límite es higiene.
   */
  @Post('reset-password')
  @HttpCode(200)
  @LimiteDeRuta(LIMITADOR_RESET_PASSWORD, { limit: 10, ttl: 900_000 })
  async resetPassword(@Body() body: unknown): Promise<{ ok: true }> {
    const datos = validarCon(resetPasswordSchema, body)
    await this.resetPasswordUseCase.ejecutar(datos)
    return { ok: true }
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() usuario: UsuarioAutenticado | undefined): UsuarioAutenticado | undefined {
    return usuario
  }

  private leerCookieRefresh(req: Request): string {
    const token = this.leerCookieRefreshOpcional(req)
    // eslint-disable-next-line security/detect-possible-timing-attacks -- no se compara un secreto: sólo se mira si la cookie venía o no
    if (token === undefined) throw new RefreshInvalidoError()
    return token
  }

  private leerCookieRefreshOpcional(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string> | undefined
    // eslint-disable-next-line security/detect-object-injection -- la clave es la constante COOKIE_REFRESH, no entrada del usuario
    return cookies?.[COOKIE_REFRESH]
  }

  /**
   * DESIGN-GAP: el brief fija `path: '/auth/refresh'` como "no negociable".
   * Tomado literalmente, esa cookie NUNCA llegaría a `POST /auth/logout` (path
   * distinto), así que el navegador jamás la enviaría y `LogoutUseCase`
   * recibiría siempre `undefined` — logout quedaría mudo en producción: el
   * cliente "cierra sesión" pero la familia de refresh sigue viva en el
   * servidor. Se amplía el `path` a `/auth` (cubre login/refresh/logout/me,
   * sigue sin llegar a `/events`, `/guests`, etc.) para que el cierre de
   * sesión sea real. httpOnly/secure/sameSite=strict se mantienen intactos.
   */
  private ponerCookieRefresh(res: Response, refreshToken: string): void {
    res.cookie(COOKIE_REFRESH, refreshToken, {
      httpOnly: true,
      secure: this.env.NODE_ENV !== 'test',
      sameSite: 'strict',
      path: '/auth',
      maxAge: this.env.REFRESH_TTL_DAYS * 86_400_000,
    })
  }
}

/**
 * Clave del límite de login. El correo se normaliza (minúsculas, sin espacios)
 * para que variar las mayúsculas no dé intentos nuevos contra la misma cuenta.
 * No hace falta ocultarlo: `ThrottlerGuard` guarda en Redis el SHA-256 de la
 * clave, no la clave.
 *
 * Corre ANTES de validar el cuerpo (los guards van antes que el handler), así
 * que no se fía de su forma: un cuerpo sin `email` de texto cuenta con la IP
 * sola.
 */
function rastreoPorIpYCorreo(req: Record<string, unknown>): string {
  const cuerpo = req.body as { email?: unknown } | undefined
  const email = typeof cuerpo?.email === 'string' ? cuerpo.email.trim().toLowerCase() : ''
  return `${typeof req.ip === 'string' ? req.ip : ''}|${email}`
}

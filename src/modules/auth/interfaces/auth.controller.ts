import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common'
import type { Request, Response } from 'express'

import { ENV } from '@/config/config.module'
import type { Env } from '@/config/env.schema'
import { validarCon } from '@/shared/http/validar-con'

import { LoginUseCase } from '../application/login.use-case'
import { LogoutUseCase } from '../application/logout.use-case'
import { RefreshUseCase } from '../application/refresh.use-case'
import { RegisterUseCase } from '../application/register.use-case'
import { RefreshInvalidoError } from '../domain/token-errors'
import { loginSchema, registerSchema } from './auth.dto'
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
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * RIESGO ACEPTADO (ligado al DESIGN-GAP #6, `register.use-case.ts`):
   * registrar un email ya existente responde `409 EMAIL_ALREADY_REGISTERED`,
   * así que este endpoint permite ENUMERAR CUENTAS — basta leer el status, sin
   * necesidad de cronometrar `/auth/login` como hace el hash señuelo de
   * `LoginUseCase`. Se filtra una sola cosa: si un email concreto tiene cuenta.
   * No se arregla aquí porque el arreglo correcto (responder siempre 201 y
   * avisar por correo al dueño de la cuenta existente) exige emitir y canjear
   * un token de verificación de email, y no hay tabla donde persistirlo: es
   * exactamente lo que el DESIGN-GAP #6 documenta como inexistente. Lo
   * desbloquea esa tabla más el endpoint de verificación; hasta entonces,
   * media feature sin dónde guardarse sería peor que el riesgo conocido.
   */
  @Post('register')
  async register(@Body() body: unknown): Promise<{ id: string; email: string; fullName: string }> {
    const datos = validarCon(registerSchema, body)
    const usuario = await this.registerUseCase.ejecutar(datos)
    return { id: usuario.id, email: usuario.email, fullName: usuario.fullName }
  }

  @Post('login')
  @HttpCode(200)
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
    if (token !== undefined) await this.logoutUseCase.ejecutar(token)
    res.clearCookie(COOKIE_REFRESH, { path: '/auth' })
    return { ok: true }
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() usuario: UsuarioAutenticado | undefined): UsuarioAutenticado | undefined {
    return usuario
  }

  private leerCookieRefresh(req: Request): string {
    const token = this.leerCookieRefreshOpcional(req)
    if (token === undefined) throw new RefreshInvalidoError()
    return token
  }

  private leerCookieRefreshOpcional(req: Request): string | undefined {
    const cookies = req.cookies as Record<string, string> | undefined
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

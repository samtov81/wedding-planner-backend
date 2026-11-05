import { describe, expect, it } from 'vitest'
import { ConflictError, ForbiddenError, NotFoundError, UnprocessableError } from '@/shared/domain'
import {
  AutocontactoError,
  ContactoYaAceptadoError,
  EscrituraEnSolicitudPendienteError,
  EsperaTrasRechazoError,
  FichaNoDisponibleError,
  RechazadoPorTiError,
  SolicitudNoPendienteError,
  SolicitudPendienteError,
} from './messaging-errors'
import {
  ESPERA_TRAS_RECHAZO_MS,
  claveDePerfil,
  estadoDeContacto,
  evaluarSolicitud,
  reintentoEn,
  veConversacionDePerfil,
  type ParDePerfil,
} from './perfil'

const YO = 'user-yo'
const DUENO = 'user-dueno'
const rechazo = new Date('2026-11-03T10:00:00.000Z')

const par = (p: Partial<ParDePerfil> = {}): ParDePerfil => ({
  conversationId: 'conv-1',
  requesterId: YO,
  vendorUserId: DUENO,
  status: 'PENDING',
  declinedAt: null,
  ...p,
})

const evaluar = (
  p: ParDePerfil | null,
  o: { relacionados?: boolean; ahora?: Date; solicitante?: string } = {},
) =>
  evaluarSolicitud({
    solicitante: o.solicitante ?? YO,
    duenoDeFicha: DUENO,
    par: p,
    relacionados: o.relacionados ?? false,
    ahora: o.ahora ?? new Date('2026-11-03T12:00:00.000Z'),
  })

describe('claveDePerfil', () => {
  it('es simétrica y ordena los ids', () => {
    expect(claveDePerfil('b', 'a')).toBe('profile:a:b')
    expect(claveDePerfil('a', 'b')).toBe('profile:a:b')
  })
})

describe('reintentoEn', () => {
  it('suma exactamente 24 horas', () => {
    expect(ESPERA_TRAS_RECHAZO_MS).toBe(86_400_000)
    expect(reintentoEn(rechazo).getTime()).toBe(rechazo.getTime() + 86_400_000)
  })
})

describe('evaluarSolicitud', () => {
  it('rechaza el autocontacto antes de mirar nada más', () => {
    expect(() => evaluar(par(), { solicitante: DUENO })).toThrow(AutocontactoError)
  })

  it('sin par crea PENDING', () => {
    expect(evaluar(null)).toEqual({ accion: 'crear', estado: 'PENDING' })
  })

  it('sin par y relacionados crea ACCEPTED', () => {
    expect(evaluar(null, { relacionados: true })).toEqual({ accion: 'crear', estado: 'ACCEPTED' })
  })

  it('con solicitud pendiente da 409, sea quien sea el solicitante', () => {
    expect(() => evaluar(par())).toThrow(SolicitudPendienteError)
    expect(() => evaluar(par({ requesterId: DUENO, vendorUserId: YO }))).toThrow(
      SolicitudPendienteError,
    )
  })

  it('con contacto aceptado da 409 con el id de la conversación', () => {
    try {
      evaluar(par({ status: 'ACCEPTED' }))
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ContactoYaAceptadoError)
      expect((e as ContactoYaAceptadoError).details).toEqual({ conversationId: 'conv-1' })
    }
  })

  it('quien rechazó no puede volver a pedir', () => {
    const declinado = par({
      status: 'DECLINED',
      declinedAt: rechazo,
      requesterId: DUENO,
      vendorUserId: YO,
    })
    expect(() => evaluar(declinado)).toThrow(RechazadoPorTiError)
  })

  it('con relación previa reabre como ACCEPTED aun dentro de las 24 h', () => {
    const declinado = par({ status: 'DECLINED', declinedAt: rechazo })
    expect(
      evaluar(declinado, { relacionados: true, ahora: new Date(rechazo.getTime() + 1) }),
    ).toEqual({ accion: 'reintentar', estado: 'ACCEPTED' })
  })

  it('antes de 24 h da espera con retryAt', () => {
    const declinado = par({ status: 'DECLINED', declinedAt: rechazo })
    const ahora = new Date(rechazo.getTime() + ESPERA_TRAS_RECHAZO_MS - 1)
    try {
      evaluar(declinado, { ahora })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(EsperaTrasRechazoError)
      expect((e as EsperaTrasRechazoError).details).toEqual({
        retryAt: reintentoEn(rechazo).toISOString(),
      })
    }
  })

  it('relacionados no salta una pendiente, una aceptada ni "rechazado por ti"', () => {
    const conRelacion = { relacionados: true }
    expect(() => evaluar(par(), conRelacion)).toThrow(SolicitudPendienteError)
    expect(() => evaluar(par({ status: 'ACCEPTED' }), conRelacion)).toThrow(ContactoYaAceptadoError)
    const rechazadoPorMi = par({
      status: 'DECLINED',
      declinedAt: rechazo,
      requesterId: DUENO,
      vendorUserId: YO,
    })
    expect(() => evaluar(rechazadoPorMi, conRelacion)).toThrow(RechazadoPorTiError)
  })

  it('a las 24 h exactas reintenta como PENDING', () => {
    const declinado = par({ status: 'DECLINED', declinedAt: rechazo })
    const ahora = new Date(rechazo.getTime() + ESPERA_TRAS_RECHAZO_MS)
    expect(evaluar(declinado, { ahora })).toEqual({ accion: 'reintentar', estado: 'PENDING' })
  })
})

describe('estadoDeContacto', () => {
  it('SELF antes de mirar el par', () => {
    expect(estadoDeContacto(DUENO, DUENO, par())).toEqual({
      state: 'SELF',
      conversationId: null,
      retryAt: null,
    })
  })

  it('NONE sin par', () => {
    expect(estadoDeContacto(YO, DUENO, null)).toEqual({
      state: 'NONE',
      conversationId: null,
      retryAt: null,
    })
  })

  it('PENDING_SENT para el solicitante', () => {
    expect(estadoDeContacto(YO, DUENO, par())).toEqual({
      state: 'PENDING_SENT',
      conversationId: 'conv-1',
      retryAt: null,
    })
  })

  it('PENDING_RECEIVED para el otro, con el id de la conversación', () => {
    expect(estadoDeContacto(YO, DUENO, par({ requesterId: 'otro' }))).toEqual({
      state: 'PENDING_RECEIVED',
      conversationId: 'conv-1',
      retryAt: null,
    })
  })

  it('ACCEPTED', () => {
    expect(estadoDeContacto(YO, DUENO, par({ status: 'ACCEPTED' }))).toEqual({
      state: 'ACCEPTED',
      conversationId: 'conv-1',
      retryAt: null,
    })
  })

  it('DECLINED para el solicitante, con retryAt', () => {
    expect(estadoDeContacto(YO, DUENO, par({ status: 'DECLINED', declinedAt: rechazo }))).toEqual({
      state: 'DECLINED',
      conversationId: 'conv-1',
      retryAt: reintentoEn(rechazo),
    })
  })

  it('DECLINED_BY_ME para quien rechazó', () => {
    const r = estadoDeContacto(
      YO,
      DUENO,
      par({ status: 'DECLINED', declinedAt: rechazo, requesterId: 'otro' }),
    )
    expect(r).toEqual({ state: 'DECLINED_BY_ME', conversationId: null, retryAt: null })
  })
})

describe('veConversacionDePerfil', () => {
  it('el proveedor no ve una solicitud rechazada', () => {
    const p = par({ status: 'DECLINED', declinedAt: rechazo })
    expect(veConversacionDePerfil(p, DUENO)).toBe(false)
  })

  it('el solicitante sí la ve rechazada', () => {
    const p = par({ status: 'DECLINED', declinedAt: rechazo })
    expect(veConversacionDePerfil(p, YO)).toBe(true)
  })

  it('un tercero no la ve en ningún estado', () => {
    for (const p of [
      par(),
      par({ status: 'ACCEPTED' }),
      par({ status: 'DECLINED', declinedAt: rechazo }),
    ]) {
      expect(veConversacionDePerfil(p, 'user-tercero')).toBe(false)
    }
  })

  it('el proveedor ve pendientes y aceptadas', () => {
    expect(veConversacionDePerfil(par(), DUENO)).toBe(true)
    expect(veConversacionDePerfil(par({ status: 'ACCEPTED' }), DUENO)).toBe(true)
  })
})

describe('errores', () => {
  it('llevan estado y código exactos', () => {
    const casos: [Error & { httpStatus: number; code: string }, number, string][] = [
      [new FichaNoDisponibleError(), 404, 'VENDOR_PROFILE_NOT_FOUND'],
      [new AutocontactoError(), 422, 'CONTACT_SELF'],
      [new SolicitudPendienteError(), 409, 'CONTACT_REQUEST_PENDING'],
      [new EscrituraEnSolicitudPendienteError(), 403, 'CONTACT_REQUEST_PENDING'],
      [new ContactoYaAceptadoError('c'), 409, 'CONTACT_ALREADY_ACCEPTED'],
      [new EsperaTrasRechazoError(new Date(0)), 409, 'CONTACT_REQUEST_COOLDOWN'],
      [new RechazadoPorTiError(), 409, 'CONTACT_DECLINED_BY_YOU'],
      [new SolicitudNoPendienteError(), 409, 'CONTACT_REQUEST_NOT_PENDING'],
    ]
    for (const [e, status, code] of casos) {
      expect(e.httpStatus).toBe(status)
      expect(e.code).toBe(code)
    }
    expect(new FichaNoDisponibleError()).toBeInstanceOf(NotFoundError)
    expect(new AutocontactoError()).toBeInstanceOf(UnprocessableError)
    expect(new EscrituraEnSolicitudPendienteError()).toBeInstanceOf(ForbiddenError)
    expect(new RechazadoPorTiError()).toBeInstanceOf(ConflictError)
  })
})

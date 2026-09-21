import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/queue.adapter.fake'
import type { DomainError } from '@/shared/domain'
import { Logger } from '@nestjs/common'

import type { Guest } from '../domain/guest'
import { InvitacionNoValidaError, RsvpCerradoError } from '../domain/guest-errors'
import { generarTokenInvitacion, type InvitationStatus } from '../domain/invitation'
import { GuestRepositoryEnMemoria } from '../infrastructure/guest.repository.fake'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { SubmitRsvpUseCase, TIPO_RSVP_ACTUALIZADO } from './submit-rsvp.use-case'

describe('SubmitRsvpUseCase', () => {
  let invitados: GuestRepositoryEnMemoria
  let invitaciones: InvitationRepositoryEnMemoria
  let notificaciones: NotificationPortEnMemoria
  let cola: InMemoryQueueAdapter
  let unidadDeTrabajo: UnidadDeTrabajoEnMemoria
  let caso: SubmitRsvpUseCase
  let tokenCaducado: string

  /**
   * El doble de invitados expone `buscar(eventId, guestId)` asíncrono (el del
   * puerto). El brief escribe `invitados.buscar('g1')` síncrono; se lee la
   * fila directamente para no añadir al doble un método que el puerto no tiene.
   */
  function invitado(id: string): Guest | undefined {
    return invitados.filas.find((g) => g.id === id)
  }

  /** El brief lo llama `guestId`: el único invitado sembrado. */
  const guestId = 'g1'

  function diasDesdeHoy(dias: number): Date {
    return new Date(Date.now() + dias * 86_400_000)
  }

  /**
   * Invitación `inv-N` del invitado `g1`, con su token en claro para el test.
   * La boda, a 60 días por defecto (el cierre, con `rsvpDeadlineDays: 14`, a
   * 46): relativa a hoy para que el test no caduque con el calendario.
   */
  let secuencia = 0
  function prepararInvitacion(
    parcial: { expiresAt?: Date; status?: InvitationStatus; weddingDate?: Date } = {},
  ): Promise<{ token: string; id: string }> {
    secuencia += 1
    const id = `inv-${secuencia}`
    const { token, hash } = generarTokenInvitacion()
    invitaciones.añadir({
      id,
      tokenHash: hash,
      expiresAt: parcial.expiresAt ?? new Date(Date.now() + 86_400_000),
      status: parcial.status ?? 'DELIVERED',
      guest: { id: guestId, eventId: 'ev-1', name: 'Ana Invitada' },
      event: { weddingDate: parcial.weddingDate ?? diasDesdeHoy(60), rsvpDeadlineDays: 14 },
    })
    return Promise.resolve({ token, id })
  }

  function prepararInvitacionValida(
    parcial: { weddingDate?: Date } = {},
  ): Promise<{ token: string; id: string }> {
    return prepararInvitacion(parcial)
  }

  async function capturarError(accion: () => Promise<unknown>): Promise<DomainError> {
    try {
      await accion()
    } catch (error) {
      return error as DomainError
    }
    throw new Error('se esperaba que la acción lanzara')
  }

  beforeEach(async () => {
    secuencia = 0
    invitados = new GuestRepositoryEnMemoria()
    invitaciones = new InvitationRepositoryEnMemoria()
    notificaciones = new NotificationPortEnMemoria()
    cola = new InMemoryQueueAdapter()
    unidadDeTrabajo = new UnidadDeTrabajoEnMemoria()

    invitados.sembrar({
      id: 'g1',
      eventId: 'ev-1',
      name: 'Ana Invitada',
      email: 'ana@test.com',
      group: 'Family',
      rsvp: 'PENDING',
      dietary: null,
      createdAt: new Date(Date.UTC(2026, 0, 1)),
    })
    notificaciones.registrarMiembros('ev-1', ['user-pareja', 'user-planner'])

    caso = new SubmitRsvpUseCase(invitaciones, invitados, notificaciones, cola, unidadDeTrabajo)

    tokenCaducado = (await prepararInvitacion({ expiresAt: new Date(Date.now() - 1000) })).token
  })

  it('actualiza el invitado y marca la invitación como respondida', async () => {
    const { token, id } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'CONFIRMED', dietary: 'Vegan' })

    expect(invitado('g1')?.rsvp).toBe('CONFIRMED')
    expect(invitado('g1')?.dietary).toBe('Vegan')
    expect(invitaciones.buscar(id)?.status).toBe('RESPONDED')
    expect(invitaciones.buscar(id)?.respondedAt).toBeInstanceOf(Date)
  })

  it('sin `dietary` no toca la dieta que ya tuviera el invitado', async () => {
    const fila = invitado('g1')
    if (fila !== undefined) fila.dietary = 'Celiac'
    const { token } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'DECLINED' })

    expect(invitado('g1')?.rsvp).toBe('DECLINED')
    expect(invitado('g1')?.dietary).toBe('Celiac')
  })

  it('`dietary: null` la borra: es una respuesta explícita, no una ausencia', async () => {
    const fila = invitado('g1')
    if (fila !== undefined) fila.dietary = 'Celiac'
    const { token } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'CONFIRMED', dietary: null })

    expect(invitado('g1')?.dietary).toBeNull()
  })

  it('permite cambiar la respuesta ya dada antes del cierre', async () => {
    const { token } = await prepararInvitacionValida()
    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    await caso.ejecutar(token, { rsvp: 'DECLINED' })

    expect(invitado(guestId)?.rsvp).toBe('DECLINED')
  })

  it('tras el cierre responde RSVP_CLOSED y no toca nada', async () => {
    const { token, id } = await prepararInvitacionValida({ weddingDate: diasDesdeHoy(10) })

    await expect(caso.ejecutar(token, { rsvp: 'CONFIRMED' })).rejects.toBeInstanceOf(
      RsvpCerradoError,
    )
    expect(invitado(guestId)?.rsvp).toBe('PENDING')
    expect(invitaciones.buscar(id)?.status).toBe('DELIVERED')
    expect(notificaciones.creadas).toHaveLength(0)
    expect(cola.encolados).toHaveLength(0)
  })

  it('RSVP_CLOSED es un 422 distinto del 404 del token no válido', async () => {
    // Distinguirlo no filtra nada: para verlo hay que tener un token válido.
    const { token } = await prepararInvitacionValida({ weddingDate: diasDesdeHoy(10) })

    const error = await capturarError(() => caso.ejecutar(token, { rsvp: 'CONFIRMED' }))

    expect(error.code).toBe('RSVP_CLOSED')
    expect(error.httpStatus).toBe(422)
    expect(error.message).not.toContain(token)
  })

  it('un token caducado da el 404 de siempre aunque además esté fuera de plazo', async () => {
    const { token } = await prepararInvitacion({
      expiresAt: new Date(Date.now() - 1000),
      weddingDate: diasDesdeHoy(10),
    })

    await expect(caso.ejecutar(token, { rsvp: 'CONFIRMED' })).rejects.toBeInstanceOf(
      InvitacionNoValidaError,
    )
  })

  it('cada respuesta encola su propio aviso', async () => {
    // Dos respuestas en el mismo milisegundo darían el mismo jobId: el reloj se
    // fija para que el test no dependa de lo rápido que corra la máquina.
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 18, 12)))
      const { token } = await prepararInvitacionValida()
      await caso.ejecutar(token, { rsvp: 'CONFIRMED' })
      vi.setSystemTime(new Date(Date.UTC(2026, 8, 18, 12, 0, 1)))
      await caso.ejecutar(token, { rsvp: 'DECLINED' })
    } finally {
      vi.useRealTimers()
    }

    const ids = cola.encolados.map((j) => j.opciones.jobId)
    expect(new Set(ids).size).toBe(2)
    expect(ids.every((id) => !id.includes(':'))).toBe(true)
  })

  it('rechaza un token caducado', async () => {
    const { token } = await prepararInvitacion({ expiresAt: new Date(Date.now() - 1000) })

    await expect(caso.ejecutar(token, { rsvp: 'CONFIRMED' })).rejects.toThrow(
      InvitacionNoValidaError,
    )
    expect(invitado('g1')?.rsvp).toBe('PENDING')
  })

  it('rechaza el token de una invitación que el worker caducó al agotar reintentos (C18)', async () => {
    const { token, id } = await prepararInvitacionValida()
    await invitaciones.caducar(id)

    await expect(caso.ejecutar(token, { rsvp: 'CONFIRMED' })).rejects.toThrow(
      InvitacionNoValidaError,
    )
  })

  it('devuelve el MISMO error para token inexistente, caducado y caducado por el worker', async () => {
    // Distinguirlos le dice a quien prueba tokens al azar cuándo ha acertado
    // uno real. Con un solo error, no aprende nada.
    const { token: porElWorker, id } = await prepararInvitacionValida()
    await invitaciones.caducar(id)

    const inexistente = await capturarError(() => caso.ejecutar('inventado', { rsvp: 'CONFIRMED' }))
    const caducado = await capturarError(() => caso.ejecutar(tokenCaducado, { rsvp: 'CONFIRMED' }))
    const c18 = await capturarError(() => caso.ejecutar(porElWorker, { rsvp: 'DECLINED' }))

    for (const error of [inexistente, caducado, c18]) {
      expect(error).toBeInstanceOf(InvitacionNoValidaError)
      expect(error.code).toBe('INVITATION_INVALID')
      expect(error.httpStatus).toBe(inexistente.httpStatus)
      expect(error.message).toBe(inexistente.message)
    }
  })

  it('el mensaje de error nunca contiene el token', async () => {
    const error = await capturarError(() => caso.ejecutar(tokenCaducado, { rsvp: 'CONFIRMED' }))

    expect(error.message).not.toContain(tokenCaducado)
  })

  it('crea una notificación por cada miembro del evento', async () => {
    const { token } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    expect(notificaciones.creadas.map((n) => n.userId).sort()).toEqual([
      'user-pareja',
      'user-planner',
    ])
    expect(notificaciones.creadas[0]).toMatchObject({
      eventId: 'ev-1',
      tipo: TIPO_RSVP_ACTUALIZADO,
      payload: { guestId: 'g1', guestName: 'Ana Invitada', rsvp: 'CONFIRMED' },
    })
  })

  it('escribe invitación, invitado y notificaciones DENTRO de una misma unidad de trabajo', async () => {
    // La atomicidad real la prueba el e2e contra Postgres; aquí se fija que
    // las tres escrituras pasan por la unidad de trabajo y no por fuera.
    const dentro = new Map<string, boolean>()
    const anotar =
      <A extends unknown[], R>(nombre: string, original: (...args: A) => R) =>
      (...args: A): R => {
        dentro.set(nombre, unidadDeTrabajo.activa)
        return original(...args)
      }
    invitaciones.marcarRespondida = anotar(
      'marcarRespondida',
      invitaciones.marcarRespondida.bind(invitaciones),
    )
    invitados.actualizar = anotar('actualizar', invitados.actualizar.bind(invitados))
    notificaciones.crearParaMiembros = anotar(
      'crearParaMiembros',
      notificaciones.crearParaMiembros.bind(notificaciones),
    )
    cola.enqueue = anotar('enqueue', cola.enqueue.bind(cola))
    const { token } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    expect(Object.fromEntries(dentro)).toEqual({
      marcarRespondida: true,
      actualizar: true,
      crearParaMiembros: true,
      // El aviso se encola FUERA y después: la cola no es parte de la verdad.
      enqueue: false,
    })
    expect(unidadDeTrabajo.transacciones).toBe(1)
  })

  it('encola el aviso en la cola `notifications` con un jobId por respuesta (C23)', async () => {
    // Quien emite en tiempo real es el WORKER de la Tarea 15, no la petición
    // HTTP: la cola le da reintentos que un emit directo no tiene.
    const { token, id } = await prepararInvitacionValida()
    const ahora = new Date(Date.UTC(2026, 8, 18, 12))
    vi.useFakeTimers({ toFake: ['Date'], now: ahora })
    try {
      await caso.ejecutar(token, { rsvp: 'DECLINED' })
    } finally {
      vi.useRealTimers()
    }

    expect(cola.encolados).toEqual([
      {
        cola: 'notifications',
        nombre: TIPO_RSVP_ACTUALIZADO,
        datos: {
          eventId: 'ev-1',
          payload: { guestId: 'g1', guestName: 'Ana Invitada', rsvp: 'DECLINED' },
        },
        jobId: `rsvp-${id}-${ahora.getTime()}`,
        opciones: { jobId: `rsvp-${id}-${ahora.getTime()}` },
      },
    ])
    // BullMQ rechaza `:` en un jobId (costó un 500 en la Tarea 8).
    expect(cola.encolados[0]?.jobId).not.toContain(':')
  })

  it('el job no lleva el token: el payload vive en Redis', async () => {
    const { token } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    expect(JSON.stringify(cola.encolados)).not.toContain(token)
  })

  it('persiste ANTES de encolar: si encolar falla, la respuesta del invitado se conserva', async () => {
    const { token, id } = await prepararInvitacionValida()
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    cola.enqueue = () => Promise.reject(new Error('redis caído'))

    // Que el aviso no se pueda encolar no puede perder la respuesta del invitado.
    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    expect(invitado('g1')?.rsvp).toBe('CONFIRMED')
    expect(invitaciones.buscar(id)?.status).toBe('RESPONDED')
    expect(notificaciones.creadas).toHaveLength(2)
    expect(aviso).toHaveBeenCalledTimes(1)
    const registrado = JSON.stringify(aviso.mock.calls)
    expect(registrado).toContain('redis caído')
    expect(registrado).not.toContain(token)
    aviso.mockRestore()
  })

  it('si la persistencia falla, no se encola nada y el error sale', async () => {
    const { token } = await prepararInvitacionValida()
    notificaciones.fallarProximaCreacion(new Error('postgres caído'))

    await expect(caso.ejecutar(token, { rsvp: 'CONFIRMED' })).rejects.toThrow('postgres caído')

    expect(cola.encolados).toEqual([])
  })

  it('un token caducado entre la lectura y la escritura no escribe nada', async () => {
    // La lectura lo vio vivo; un reenvío (C24) lo caduca antes de la escritura.
    // La guarda de la ESCRITURA (`marcarRespondida` condicionado) es la que decide.
    const { token, id } = await prepararInvitacionValida()
    const original = invitaciones.marcarRespondida.bind(invitaciones)
    invitaciones.marcarRespondida = async (suId, ahora) => {
      await invitaciones.caducarVigentesDe(guestId, ahora)
      return original(suId, ahora)
    }

    await expect(caso.ejecutar(token, { rsvp: 'CONFIRMED' })).rejects.toBeInstanceOf(
      InvitacionNoValidaError,
    )
    expect(invitado(guestId)?.rsvp).toBe('PENDING')
    expect(invitaciones.buscar(id)?.status).toBe('DELIVERED')
    expect(notificaciones.creadas).toHaveLength(0)
  })
})

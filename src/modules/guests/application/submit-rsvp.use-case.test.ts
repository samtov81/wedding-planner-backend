import { UnidadDeTrabajoEnMemoria } from '@/modules/database/infrastructure/unidad-de-trabajo.fake'
import { NotificationPortEnMemoria } from '@/modules/notifications/infrastructure/notification.port.fake'
import { InMemoryQueueAdapter } from '@/modules/queue/infrastructure/in-memory-queue.adapter'
import type { DomainError } from '@/shared/domain'
import { Logger } from '@nestjs/common'

import type { Guest } from '../domain/guest'
import { InvitacionNoValidaError } from '../domain/guest-errors'
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

  /** Invitación `inv-N` del invitado `g1`, con su token en claro para el test. */
  let secuencia = 0
  function prepararInvitacion(
    parcial: { expiresAt?: Date; status?: InvitationStatus } = {},
  ): Promise<{ token: string; id: string }> {
    secuencia += 1
    const id = `inv-${secuencia}`
    const { token, hash } = generarTokenInvitacion()
    invitaciones.añadir({
      id,
      tokenHash: hash,
      expiresAt: parcial.expiresAt ?? new Date(Date.now() + 86_400_000),
      status: parcial.status ?? 'DELIVERED',
      guest: { id: 'g1', eventId: 'ev-1', name: 'Ana Invitada' },
    })
    return Promise.resolve({ token, id })
  }

  function prepararInvitacionValida(): Promise<{ token: string; id: string }> {
    return prepararInvitacion()
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

  it('rechaza un token que ya se usó', async () => {
    const { token } = await prepararInvitacionValida()
    await caso.ejecutar(token, { rsvp: 'CONFIRMED' })

    await expect(caso.ejecutar(token, { rsvp: 'DECLINED' })).rejects.toThrow(
      InvitacionNoValidaError,
    )
    // Y la segunda respuesta no llegó a escribirse.
    expect(invitado('g1')?.rsvp).toBe('CONFIRMED')
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

  it('devuelve el MISMO error para token inexistente, usado y caducado', async () => {
    // Distinguirlos le dice a quien prueba tokens al azar cuándo ha acertado
    // uno real. Con un solo error, no aprende nada.
    const { token: usado } = await prepararInvitacionValida()
    await caso.ejecutar(usado, { rsvp: 'CONFIRMED' })

    const inexistente = await capturarError(() => caso.ejecutar('inventado', { rsvp: 'CONFIRMED' }))
    const caducado = await capturarError(() => caso.ejecutar(tokenCaducado, { rsvp: 'CONFIRMED' }))
    const reutilizado = await capturarError(() => caso.ejecutar(usado, { rsvp: 'DECLINED' }))

    for (const error of [inexistente, caducado, reutilizado]) {
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

  it('encola el aviso en la cola `notifications` con un jobId estable por invitación (C23)', async () => {
    // Quien emite en tiempo real es el WORKER de la Tarea 15, no la petición
    // HTTP: la cola le da reintentos que un emit directo no tiene.
    const { token, id } = await prepararInvitacionValida()

    await caso.ejecutar(token, { rsvp: 'DECLINED' })

    expect(cola.encolados).toEqual([
      {
        cola: 'notifications',
        nombre: TIPO_RSVP_ACTUALIZADO,
        datos: {
          eventId: 'ev-1',
          payload: { guestId: 'g1', guestName: 'Ana Invitada', rsvp: 'DECLINED' },
        },
        jobId: `rsvp-${id}`,
        opciones: { jobId: `rsvp-${id}` },
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

  it('dos respuestas simultáneas con el mismo token: sólo una gana', async () => {
    // Ambas leen la invitación válida; la guarda de la ESCRITURA
    // (`marcarRespondida` condicionado) es la que decide, no la lectura previa.
    const { token } = await prepararInvitacionValida()

    const resultados = await Promise.allSettled([
      caso.ejecutar(token, { rsvp: 'CONFIRMED' }),
      caso.ejecutar(token, { rsvp: 'DECLINED' }),
    ])

    expect(resultados.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rechazo = resultados.find((r) => r.status === 'rejected')
    expect(rechazo?.status === 'rejected' ? rechazo.reason : null).toBeInstanceOf(
      InvitacionNoValidaError,
    )
    expect(notificaciones.creadas).toHaveLength(2)
  })
})

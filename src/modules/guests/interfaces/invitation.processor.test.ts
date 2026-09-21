import { Logger } from '@nestjs/common'
import { UnrecoverableError, type Job } from 'bullmq'

import type { InvitationRenderer } from '@/modules/mail/application/invitation-renderer.port'
import type { MailPort } from '@/modules/mail/application/mail.port'
import { FakeMailAdapter } from '@/modules/mail/infrastructure/mail.adapter.fake'

import {
  COLA_INVITACIONES,
  JOB_INVITACION,
  type PayloadInvitacion,
} from '../application/send-invitations.use-case'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { InvitationProcessor } from './invitation.processor'

/**
 * Clave de metadata de `@Processor`. `@nestjs/bullmq` no la exporta en su
 * `exports` de paquete, así que se repite el literal de `bull.constants.js`.
 */
const PROCESSOR_METADATA = 'bullmq:processor_metadata'

/**
 * Doble LOCAL de la plantilla. Antes este test importaba `renderGuestInvitation`
 * de `mail/infrastructure/templates`, es decir, las tripas de otro módulo: la
 * regla `tests-solo-dobles-de-otros-modulos` del gate lo prohíbe desde la Tarea
 * 11. Lo que aquí se prueba es el WORKER —que pasa el `rsvpUrl` correcto a la
 * plantilla y manda lo que ésta devuelve—, no el HTML de React Email, que tiene
 * su propio test en `mail/infrastructure/templates/guest-invitation.test.ts`.
 * El doble copia el `rsvpUrl` a las dos versiones porque el contrato del puerto
 * es exactamente ése: el enlace va en el HTML y también en el texto plano.
 */
const plantillaDoble: InvitationRenderer = {
  render: (datos) =>
    Promise.resolve({
      html: `<a href="${datos.rsvpUrl}">Confirm your attendance</a>`,
      text: `Confirm your attendance: ${datos.rsvpUrl}`,
    }),
}

describe('InvitationProcessor', () => {
  let invitaciones: InvitationRepositoryEnMemoria
  let mail: FakeMailAdapter
  let procesador: InvitationProcessor

  /**
   * Un job de mentira: el worker mira `data` y, para saber si es el ÚLTIMO
   * intento, `attemptsMade` (intentos fallidos previos) y `opts.attempts`.
   * Por defecto, el primero de cinco, como la política del adaptador.
   */
  function jobFalso(
    datos: Partial<PayloadInvitacion>,
    intento: { attemptsMade: number; attempts: number } = { attemptsMade: 0, attempts: 5 },
  ): Job {
    const data: PayloadInvitacion = {
      invitationId: datos.invitationId ?? 'inv-1',
      token: datos.token ?? 'token-en-claro',
      requestId: datos.requestId ?? 'req-1',
    }
    return {
      name: JOB_INVITACION,
      data,
      attemptsMade: intento.attemptsMade,
      opts: { attempts: intento.attempts },
    } as Job
  }

  const CADUCIDAD_ORIGINAL = new Date(Date.UTC(2027, 0, 1))
  /** Relativa a hoy: una caducidad fija empieza a mentir cuando llega su fecha. */
  const MAÑANA = (): Date => new Date(Date.now() + 86_400_000)

  /**
   * El worker registra cada descarte. En test ese ruido tapa el resultado, así
   * que se silencia de una vez y los tests que lo comprueban leen este mismo
   * espía en vez de montar otro.
   */
  const espiarLog = (): ReturnType<typeof vi.spyOn> =>
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined)
  let registroLog: ReturnType<typeof espiarLog>

  afterEach(() => {
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    registroLog = espiarLog()
    invitaciones = new InvitationRepositoryEnMemoria()
    mail = new FakeMailAdapter()
    procesador = new InvitationProcessor(
      invitaciones,
      mail,
      { APP_URL: 'https://app.test' },
      plantillaDoble,
    )
  })

  it('no reintenta cuando la invitación ya no existe', async () => {
    await procesador.process(jobFalso({ invitationId: 'borrada' }))

    expect(mail.enviados).toHaveLength(0)
  })

  it('no reenvía una invitación que ya está SENT', async () => {
    invitaciones.añadir({ id: 'inv-1', status: 'SENT' })

    await procesador.process(jobFalso({ invitationId: 'inv-1' }))

    expect(mail.enviados).toHaveLength(0)
  })

  it('no manda un enlace muerto: un job cuya invitación ya caducó no envía nada (C24)', async () => {
    // Un reenvío o un cambio de email caducó esta invitación mientras su job
    // esperaba en la cola: mandarla sería mandar un enlace que ya da 404.
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: new Date(Date.now() - 1) })
    const aviso = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)

    await procesador.process(jobFalso({ invitationId: 'inv-1', token: 'token-muerto' }))

    expect(mail.enviados).toHaveLength(0)
    expect(invitaciones.buscar('inv-1')?.status).toBe('QUEUED')
    // Y dice por qué, con el invitationId y SIN el token.
    const registrado = aviso.mock.calls.map((llamada) => String(llamada[0])).join('\n')
    expect(registrado).toContain('invitationId=inv-1')
    expect(registrado).not.toContain('token-muerto')
    aviso.mockRestore()
  })

  it('no intenta escribir a un invitado que se quedó sin correo', async () => {
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', guest: { email: null } })

    await procesador.process(jobFalso({ invitationId: 'inv-1' }))

    expect(mail.enviados).toHaveLength(0)
  })

  it('propaga el fallo del proveedor para que BullMQ reintente', async () => {
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED' })
    mail.fallarProximoEnvio(new Error('proveedor caído'))

    await expect(procesador.process(jobFalso({ invitationId: 'inv-1' }))).rejects.toThrow(
      'proveedor caído',
    )
    // Y la invitación NO queda marcada como enviada: si lo quedara, el
    // reintento la vería SENT y no mandaría nunca el correo.
    expect(invitaciones.buscar('inv-1')?.status).toBe('QUEUED')
  })

  it('guarda el id del proveedor al enviar, para que el webhook pueda casarlo', async () => {
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED' })

    await procesador.process(jobFalso({ invitationId: 'inv-1' }))

    expect(invitaciones.buscar('inv-1')?.resendMessageId).toMatch(/^fake-/)
    expect(invitaciones.buscar('inv-1')?.status).toBe('SENT')
  })

  it('el correo lleva el enlace de RSVP con el token en claro del job', async () => {
    invitaciones.añadir({
      id: 'inv-1',
      status: 'QUEUED',
      guest: { email: 'ana@test.com', name: 'Ana' },
      event: { name: 'Boda de Ana' },
    })

    await procesador.process(jobFalso({ invitationId: 'inv-1', token: 'abc123' }))

    const enviado = mail.enviados[0]
    expect(enviado?.to).toBe('ana@test.com')
    expect(enviado?.subject).toContain('Boda de Ana')
    expect(enviado?.html).toContain('https://app.test/rsvp/abc123')
    expect(enviado?.text).toContain('https://app.test/rsvp/abc123')
    expect(enviado?.tags).toMatchObject({ invitationId: 'inv-1' })
  })

  it('procesar DOS VECES el mismo job manda UN solo correo', async () => {
    // BullMQ reentrega: la idempotencia no es hipotética.
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED' })

    await procesador.process(jobFalso({ invitationId: 'inv-1' }))
    await procesador.process(jobFalso({ invitationId: 'inv-1' }))

    expect(mail.enviados).toHaveLength(1)
  })

  it('un payload de invitación malformado no envía y NO se reintenta', async () => {
    // Lo que sale de Redis es entrada, no código nuestro: se valida. Y un
    // payload roto no lo arregla ningún reintento, así que falla sin reintentar.
    const roto = { name: JOB_INVITACION, data: { invitationId: 42 } } as unknown as Job

    await expect(procesador.process(roto)).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mail.enviados).toHaveLength(0)
  })

  it('si falla el marcado DESPUÉS de un envío correcto, el reintento no manda otro correo', async () => {
    // La ventana que la guarda de `status` no cubre: el correo ya salió, pero
    // la invitación sigue QUEUED. La clave de idempotencia hacia el proveedor
    // es lo que convierte el reintento en un no-op.
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED' })
    invitaciones.fallarProximoMarcado(new Error('base de datos caída'))

    await expect(procesador.process(jobFalso({ invitationId: 'inv-1' }))).rejects.toThrow(
      'base de datos caída',
    )
    await procesador.process(jobFalso({ invitationId: 'inv-1' }))

    expect(mail.enviados).toHaveLength(1)
    expect(mail.enviados[0]?.idempotencyKey).toBe('invitation-inv-1')
    expect(invitaciones.buscar('inv-1')?.status).toBe('SENT')
  })

  it('un envío sin id del proveedor (409 de idempotencia) marca SENT y NO caduca nada', async () => {
    // Lo que devuelve el adaptador de Resend ante un conflicto de idempotencia
    // (bloque A §5): el correo de esa clave ya salió, pero sin id que casar.
    // La invitación tiene que quedar ENVIADA, no caducada: el enlace está en la
    // bandeja del invitado.
    const caducidad = MAÑANA()
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: caducidad })
    const sinId: MailPort = { send: () => Promise.resolve({}) }
    const conConflicto = new InvitationProcessor(
      invitaciones,
      sinId,
      { APP_URL: 'https://app.test' },
      plantillaDoble,
    )

    await conConflicto.process(jobFalso({ invitationId: 'inv-1' }))

    expect(invitaciones.buscar('inv-1')?.status).toBe('SENT')
    expect(invitaciones.buscar('inv-1')?.resendMessageId).toBeNull()
    expect(invitaciones.buscar('inv-1')?.expiresAt).toEqual(caducidad)
  })

  it('escucha SU cola, no la `email` compartida con otros productores', () => {
    // Un worker que toma un job ajeno y retorna lo marca COMPLETADO y BullMQ lo
    // borra: los `verify-email` y `event-invitation` desaparecerían sin enviarse.
    // La única forma de que esperen en `waiting` a su worker es no escuchar su cola.
    const metadatos = Reflect.getMetadata(PROCESSOR_METADATA, InvitationProcessor) as {
      name: string
    }
    expect(metadatos.name).toBe(COLA_INVITACIONES)
  })

  it('el ÚLTIMO intento fallido caduca la invitación: el token que quede en Redis ya no vale', async () => {
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: CADUCIDAD_ORIGINAL })
    mail.fallarProximoEnvio(new Error('proveedor caído'))
    const antes = Date.now()

    await expect(
      procesador.process(jobFalso({ invitationId: 'inv-1' }, { attemptsMade: 4, attempts: 5 })),
    ).rejects.toThrow('proveedor caído')

    const expira = invitaciones.buscar('inv-1')?.expiresAt.getTime() ?? Infinity
    expect(expira).toBeGreaterThanOrEqual(antes)
    expect(expira).toBeLessThanOrEqual(Date.now())
  })

  it('un intento NO final que falla no caduca nada: BullMQ lo va a reintentar', async () => {
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: CADUCIDAD_ORIGINAL })
    mail.fallarProximoEnvio(new Error('proveedor caído'))

    await expect(
      procesador.process(jobFalso({ invitationId: 'inv-1' }, { attemptsMade: 3, attempts: 5 })),
    ).rejects.toThrow('proveedor caído')

    expect(invitaciones.buscar('inv-1')?.expiresAt).toEqual(CADUCIDAD_ORIGINAL)
  })

  it('si el correo YA salió y falla el marcado en el último intento, NO se caduca', async () => {
    // El enlace está en la bandeja del invitado: caducarlo le rompería el RSVP.
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: CADUCIDAD_ORIGINAL })
    invitaciones.fallarProximoMarcado(new Error('base de datos caída'))

    await expect(
      procesador.process(jobFalso({ invitationId: 'inv-1' }, { attemptsMade: 4, attempts: 5 })),
    ).rejects.toThrow('base de datos caída')

    expect(mail.enviados).toHaveLength(1)
    expect(invitaciones.buscar('inv-1')?.expiresAt).toEqual(CADUCIDAD_ORIGINAL)
  })
  describe('descartes registrados', () => {
    // Los tres `return` silenciosos de `enviar` dejaban un job completado sin
    // rastro: desde fuera, un correo que no llega y ninguna explicación.
    // Se registra el motivo con el id, NUNCA con el token.
    const casos: Array<[string, () => void, string]> = [
      ['la invitación ya no existe', () => undefined, 'no existe'],
      [
        'la invitación ya no está en cola',
        () => {
          invitaciones.añadir({ id: 'inv-1', status: 'SENT', expiresAt: MAÑANA() })
        },
        'SENT',
      ],
      [
        'el invitado se quedó sin correo',
        () => {
          invitaciones.añadir({
            id: 'inv-1',
            status: 'QUEUED',
            expiresAt: MAÑANA(),
            guest: { email: null },
          })
        },
        'sin email',
      ],
    ]

    it.each(casos)('dice que %s, con el id y sin el token', async (_caso, sembrar, motivo) => {
      sembrar()

      await procesador.process(
        jobFalso({ invitationId: 'inv-1', token: 'token-secreto', requestId: 'req-9' }),
      )

      const registrado = registroLog.mock.calls.map((llamada) => String(llamada[0])).join('\n')
      expect(registrado).toContain(motivo)
      expect(registrado).toContain('invitationId=inv-1')
      expect(registrado).toContain('requestId=req-9')
      expect(registrado).not.toContain('token-secreto')
    })
  })

  describe('respaldo del evento `failed` (ruling C18)', () => {
    // Un job que BullMQ da por atascado (`stalled`) NUNCA entra en el `catch`
    // de `process`: sin este respaldo, su token seguiría vivo en Redis.
    it('un job que falla sin pasar por `process` (stalled) caduca la invitación al agotar intentos', async () => {
      invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: MAÑANA() })

      await procesador.alFallar(
        jobFalso({ invitationId: 'inv-1' }, { attemptsMade: 5, attempts: 5 }),
        new Error('job stalled more than allowable limit'),
      )

      expect(invitaciones.buscar('inv-1')?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())
    })

    it('un fallo con intentos pendientes no caduca nada', async () => {
      const caducidad = MAÑANA()
      invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: caducidad })

      await procesador.alFallar(
        jobFalso({ invitationId: 'inv-1' }, { attemptsMade: 2, attempts: 5 }),
        new Error('x'),
      )

      expect(invitaciones.buscar('inv-1')?.expiresAt).toEqual(caducidad)
    })

    it('un `UnrecoverableError` caduca aunque queden intentos: BullMQ no lo va a reintentar', async () => {
      invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: MAÑANA() })

      await procesador.alFallar(
        jobFalso({ invitationId: 'inv-1' }, { attemptsMade: 0, attempts: 5 }),
        new UnrecoverableError('payload roto'),
      )

      expect(invitaciones.buscar('inv-1')?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now())
    })

    it('si el correo YA salió, el respaldo tampoco caduca: el enlace está en la bandeja', async () => {
      // El fallo fue al marcar, después de un envío bueno. El evento `failed`
      // no ve lo que pasó dentro de `process`, así que hay que decírselo: si
      // caducara, el invitado tendría en su bandeja un enlace que da 404.
      const caducidad = MAÑANA()
      invitaciones.añadir({ id: 'inv-1', status: 'QUEUED', expiresAt: caducidad })
      invitaciones.fallarProximoMarcado(new Error('base de datos caída'))
      await expect(
        procesador.process(jobFalso({ invitationId: 'inv-1' }, { attemptsMade: 4, attempts: 5 })),
      ).rejects.toThrow('base de datos caída')

      // BullMQ cuenta el intento y emite `failed`: ya no quedan intentos.
      await procesador.alFallar(
        jobFalso({ invitationId: 'inv-1' }, { attemptsMade: 5, attempts: 5 }),
        new Error('base de datos caída'),
      )

      expect(mail.enviados).toHaveLength(1)
      expect(invitaciones.buscar('inv-1')?.expiresAt).toEqual(caducidad)
    })

    it('un payload que no identifica invitación no caduca nada y no lanza', async () => {
      const roto = {
        name: JOB_INVITACION,
        data: { invitationId: 42 },
        attemptsMade: 5,
        opts: { attempts: 5 },
      } as unknown as Job

      await expect(procesador.alFallar(roto, new Error('x'))).resolves.toBeUndefined()
    })

    it('sin job (BullMQ puede no traerlo) no lanza', async () => {
      await expect(procesador.alFallar(undefined, new Error('x'))).resolves.toBeUndefined()
    })
  })
})

import { UnrecoverableError, type Job } from 'bullmq'

import type { InvitationRenderer } from '@/modules/mail/application/invitation-renderer.port'
import { FakeMailAdapter } from '@/modules/mail/infrastructure/fake-mail.adapter'
import { renderGuestInvitation } from '@/modules/mail/infrastructure/templates/guest-invitation'

import { JOB_INVITACION, type PayloadInvitacion } from '../application/send-invitations.use-case'
import { InvitationRepositoryEnMemoria } from '../infrastructure/invitation.repository.fake'
import { InvitationProcessor } from './invitation.processor'

describe('InvitationProcessor', () => {
  let invitaciones: InvitationRepositoryEnMemoria
  let mail: FakeMailAdapter
  let procesador: InvitationProcessor

  /** Un job de mentira: el worker sólo mira `name` y `data`. */
  function jobFalso(datos: Partial<PayloadInvitacion>, name: string = JOB_INVITACION): Job {
    const data: PayloadInvitacion = {
      invitationId: datos.invitationId ?? 'inv-1',
      token: datos.token ?? 'token-en-claro',
      requestId: datos.requestId ?? 'req-1',
    }
    return { name, data } as Job
  }

  beforeEach(() => {
    invitaciones = new InvitationRepositoryEnMemoria()
    mail = new FakeMailAdapter()
    // La plantilla REAL, no un doble: el enlace de RSVP tiene que aparecer en
    // el HTML que de verdad se manda, no en uno de mentira.
    const plantilla: InvitationRenderer = { render: renderGuestInvitation }
    procesador = new InvitationProcessor(
      invitaciones,
      mail,
      { APP_URL: 'https://app.test' },
      plantilla,
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

  it('ignora un job de OTRO tipo en la cola compartida: ni envía ni lanza', async () => {
    // `email` es la cola de TODO el correo. Un aviso de contraseña que caiga
    // aquí no es una invitación rota: es otro trabajo, y no es de este worker.
    invitaciones.añadir({ id: 'inv-1', status: 'QUEUED' })

    await expect(
      procesador.process(jobFalso({ invitationId: 'inv-1' }, 'password-reset')),
    ).resolves.toBeUndefined()

    expect(mail.enviados).toHaveLength(0)
    expect(invitaciones.buscar('inv-1')?.status).toBe('QUEUED')
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
})

import { UnrecoverableError, type Job } from 'bullmq'

import type { Env } from '@/config/env.schema'
import type { EmailVerificationRenderer } from '@/modules/mail/application/email-verification-renderer.port'
import type { PasswordChangedRenderer } from '@/modules/mail/application/password-changed-renderer.port'
import type { PasswordResetRenderer } from '@/modules/mail/application/password-reset-renderer.port'
import type { RegistrationNoticeRenderer } from '@/modules/mail/application/registration-notice-renderer.port'
import { FakeMailAdapter } from '@/modules/mail/infrastructure/mail.adapter.fake'

import { EmailProcessor } from './email.processor'

/**
 * Dobles LOCALES de las plantillas: la regla `tests-solo-dobles-de-otros-modulos`
 * prohíbe importar `mail/infrastructure/templates` desde aquí. Lo que se prueba
 * es el WORKER —qué `verifyUrl` compone, qué manda y qué descarta—, no el HTML
 * de React Email, que tiene su propio test en el módulo `mail`.
 */
const plantillaVerificacion: EmailVerificationRenderer = {
  render: (datos) =>
    Promise.resolve({
      html: `<a href="${datos.verifyUrl}">Verify</a>`,
      text: `Verify: ${datos.verifyUrl}`,
    }),
}

const plantillaAviso: RegistrationNoticeRenderer = {
  render: (datos) =>
    Promise.resolve({ html: `<p>Hi ${datos.fullName}</p>`, text: `Hi ${datos.fullName}` }),
}

const plantillaReset: PasswordResetRenderer = {
  render: (datos) =>
    Promise.resolve({
      html: `<a href="${datos.resetUrl}">Reset</a> ${datos.minutosDeValidez}`,
      text: `Reset: ${datos.resetUrl}`,
    }),
}

const plantillaCambio: PasswordChangedRenderer = {
  render: (datos) =>
    Promise.resolve({
      html: `<p>Changed ${datos.recoverUrl} ${datos.cambiadoEn.toISOString()}</p>`,
      text: `Changed ${datos.recoverUrl} ${datos.cambiadoEn.toISOString()}`,
    }),
}

const ENV_DE_PRUEBA = { APP_URL: 'https://app.test', PASSWORD_RESET_TTL_MINUTES: 30 } as Env

describe('EmailProcessor', () => {
  let mail: FakeMailAdapter
  let procesador: EmailProcessor

  function jobFalso(name: string, data: unknown): Job {
    return { name, data } as Job
  }

  const PAYLOAD_VERIFICACION = {
    userId: 'u-1',
    tokenId: 't-1',
    email: 'ana@test.com',
    fullName: 'Ana',
    token: 'token-en-claro',
  }
  const PAYLOAD_AVISO = { userId: 'u-1', email: 'ana@test.com', fullName: 'Ana' }

  beforeEach(() => {
    mail = new FakeMailAdapter()
    procesador = new EmailProcessor(
      mail,
      ENV_DE_PRUEBA,
      plantillaVerificacion,
      plantillaAviso,
      plantillaReset,
      plantillaCambio,
    )
  })

  describe('send-verification-email', () => {
    it('manda el correo a la dirección del payload, con HTML y texto', async () => {
      await procesador.process(jobFalso('send-verification-email', PAYLOAD_VERIFICACION))

      const enviado = mail.enviados[0]
      expect(mail.enviados).toHaveLength(1)
      expect(enviado?.to).toBe('ana@test.com')
      expect(enviado?.html).toContain('token-en-claro')
      expect(enviado?.text).toContain('token-en-claro')
    })

    it('compone el enlace contra APP_URL, con el token como query param', async () => {
      await procesador.process(jobFalso('send-verification-email', PAYLOAD_VERIFICACION))

      // Query param y no segmento de ruta: el frontend resuelve `/verify-email`
      // con un switch sobre el pathname, sin router de segmentos.
      expect(mail.enviados[0]?.html).toContain(
        'https://app.test/verify-email?token=token-en-claro',
      )
    })

    it('codifica el token en la URL', async () => {
      // base64url no produce caracteres que haya que escapar, pero el worker no
      // puede depender de eso: si mañana cambia el alfabeto del token, un `+`
      // sin codificar llegaría al backend como espacio y no verificaría nada.
      await procesador.process(
        jobFalso('send-verification-email', { ...PAYLOAD_VERIFICACION, token: 'a+b/c=d' }),
      )

      expect(mail.enviados[0]?.html).toContain('token=a%2Bb%2Fc%3Dd')
      expect(mail.enviados[0]?.html).not.toContain('token=a+b/c=d')
    })

    it('usa el mismo string que el jobId como clave de idempotencia', async () => {
      // El reintento de BullMQ vuelve a entrar aquí con el mismo payload: la
      // clave es lo único que impide mandar el correo dos veces.
      await procesador.process(jobFalso('send-verification-email', PAYLOAD_VERIFICACION))
      await procesador.process(jobFalso('send-verification-email', PAYLOAD_VERIFICACION))

      expect(mail.enviados[0]?.idempotencyKey).toBe('verify-email-t-1')
      expect(mail.enviados).toHaveLength(1)
    })

    it('un payload sin token es UnrecoverableError: no se reintenta un job roto', async () => {
      const { token: _sin, ...sinToken } = PAYLOAD_VERIFICACION

      await expect(
        procesador.process(jobFalso('send-verification-email', sinToken)),
      ).rejects.toBeInstanceOf(UnrecoverableError)
      expect(mail.enviados).toHaveLength(0)
    })

    it('un email malformado tampoco se reintenta', async () => {
      await expect(
        procesador.process(
          jobFalso('send-verification-email', { ...PAYLOAD_VERIFICACION, email: 'no-es-un-email' }),
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError)
    })

    it('usa el id del token como clave de idempotencia, no el del usuario', async () => {
      await procesador.process(
        jobFalso('send-verification-email', { ...PAYLOAD_VERIFICACION, tokenId: 'token-7' }),
      )

      expect(mail.enviados).toHaveLength(1)
      expect(mail.enviados[0]?.idempotencyKey).toBe('verify-email-token-7')
    })

    it('rechaza sin reintento un payload de verificación sin tokenId', async () => {
      const { tokenId: _sin, ...sinTokenId } = { ...PAYLOAD_VERIFICACION, tokenId: 'token-7' }

      await expect(
        procesador.process(jobFalso('send-verification-email', sinTokenId)),
      ).rejects.toBeInstanceOf(UnrecoverableError)
    })
  })

  describe('send-registration-notice', () => {
    it('manda el aviso a la cuenta existente', async () => {
      await procesador.process(jobFalso('send-registration-notice', PAYLOAD_AVISO))

      expect(mail.enviados[0]?.to).toBe('ana@test.com')
      expect(mail.enviados[0]?.idempotencyKey).toBe('registration-notice-u-1')
    })

    it('el aviso sale sin enlace ni token, aunque el payload traiga uno de más', async () => {
      // La plantilla del aviso no recibe token porque el puerto no lo acepta:
      // quien provoca el aviso no puede hacer que le llegue nada accionable
      // al buzón ajeno. Se fija aquí, en la frontera, no sólo en la plantilla.
      await procesador.process(
        jobFalso('send-registration-notice', { ...PAYLOAD_AVISO, token: 'token-colado' }),
      )

      expect(mail.enviados[0]?.html).not.toContain('token-colado')
      expect(mail.enviados[0]?.text).not.toContain('token-colado')
      expect(mail.enviados[0]?.html).not.toContain('verify-email')
    })

    it('un payload incompleto es UnrecoverableError', async () => {
      await expect(
        procesador.process(jobFalso('send-registration-notice', { userId: 'u-1' })),
      ).rejects.toBeInstanceOf(UnrecoverableError)
      expect(mail.enviados).toHaveLength(0)
    })
  })

  describe('send-password-reset-email', () => {
    const PAYLOAD = { userId: 'u-1', tokenId: 'r-1', email: 'ana@test.com', fullName: 'Ana', token: 'a+b/c' }

    it('manda el enlace a /reset-password con el token codificado y la caducidad', async () => {
      await procesador.process(jobFalso('send-password-reset-email', PAYLOAD))

      const enviado = mail.enviados[0]
      expect(enviado?.to).toBe('ana@test.com')
      expect(enviado?.subject).toBe('Reset your password')
      expect(enviado?.html).toContain('https://app.test/reset-password?token=a%2Bb%2Fc')
      expect(enviado?.html).toContain('30')
      expect(enviado?.idempotencyKey).toBe('password-reset-r-1')
    })

    it('descarta sin reintentar un payload inválido, con el mensaje concreto', async () => {
      await expect(
        procesador.process(jobFalso('send-password-reset-email', { ...PAYLOAD, token: '' })),
      ).rejects.toThrow('Payload de recuperación inválido')
      expect(mail.enviados).toHaveLength(0)
    })
  })

  describe('send-password-changed-notice', () => {
    const PAYLOAD = {
      userId: 'u-1',
      tokenId: 'r-1',
      email: 'ana@test.com',
      fullName: 'Ana',
      cambiadoEn: '2026-09-22T10:00:00.000Z',
    }

    it('manda el aviso con enlace a /forgot-password y clave por token', async () => {
      await procesador.process(jobFalso('send-password-changed-notice', PAYLOAD))

      const enviado = mail.enviados[0]
      expect(enviado?.subject).toBe('Your password was changed')
      expect(enviado?.html).toContain('https://app.test/forgot-password')
      expect(enviado?.idempotencyKey).toBe('password-changed-r-1')
    })

    it('pasa `cambiadoEn` del payload al renderer, no la hora de proceso', async () => {
      await procesador.process(jobFalso('send-password-changed-notice', PAYLOAD))

      // La plantilla local de este test compone la fecha con `toISOString()`
      // (ver arriba): si el worker usara `new Date()` en vez del payload, esta
      // hora fija de 2026 nunca aparecería en el correo.
      expect(mail.enviados[0]?.html).toContain('2026-09-22T10:00:00.000Z')
    })

    it('descarta sin reintentar un payload inválido, con el mensaje concreto', async () => {
      await expect(
        procesador.process(jobFalso('send-password-changed-notice', { userId: 'u-1' })),
      ).rejects.toThrow('Payload de aviso de cambio inválido')
    })

    it('un payload sin `cambiadoEn` es UnrecoverableError', async () => {
      const { cambiadoEn: _sin, ...sinCambiadoEn } = PAYLOAD

      await expect(
        procesador.process(jobFalso('send-password-changed-notice', sinCambiadoEn)),
      ).rejects.toBeInstanceOf(UnrecoverableError)
      expect(mail.enviados).toHaveLength(0)
    })
  })

  it('un nombre de job desconocido en la cola `email` no se reintenta', async () => {
    // O es un bug del productor, o una versión futura que este worker no
    // entiende. En los dos casos reintentar cinco veces no arregla nada.
    await expect(
      procesador.process(jobFalso('send-something-else', PAYLOAD_AVISO)),
    ).rejects.toBeInstanceOf(UnrecoverableError)
    expect(mail.enviados).toHaveLength(0)
  })

  it('un fallo del proveedor SÍ sube tal cual, para que BullMQ lo reintente', async () => {
    // Distinción clave frente a UnrecoverableError: un 503 del proveedor es
    // transitorio y el correo todavía puede salir en el siguiente intento.
    mail.fallarProximoEnvio(new Error('proveedor caído'))

    await expect(
      procesador.process(jobFalso('send-verification-email', PAYLOAD_VERIFICACION)),
    ).rejects.not.toBeInstanceOf(UnrecoverableError)
  })
})

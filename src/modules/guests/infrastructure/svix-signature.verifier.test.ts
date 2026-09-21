import { Webhook } from 'svix'

import { FirmaInvalidaError } from '../domain/guest-errors'
import { SvixSignatureVerifier } from './svix-signature.verifier'

const SECRETO = `whsec_${Buffer.from('secreto-de-pruebas-de-32-bytes!!').toString('base64')}`

/**
 * Firma como lo haría Resend: HMAC sobre `id.timestamp.cuerpo`, con los BYTES
 * exactos del cuerpo.
 */
function firmar(
  cuerpo: string,
  { secreto = SECRETO, cuando = new Date() }: { secreto?: string; cuando?: Date } = {},
): Record<string, string> {
  const id = 'msg_2Lh9KQpL0'
  return {
    'svix-id': id,
    'svix-timestamp': String(Math.floor(cuando.getTime() / 1000)),
    'svix-signature': new Webhook(secreto).sign(id, cuando, cuerpo),
  }
}

describe('SvixSignatureVerifier', () => {
  const verificador = new SvixSignatureVerifier({ RESEND_WEBHOOK_SECRET: SECRETO })

  // Espacios y orden de claves que `JSON.stringify(JSON.parse(x))` NO conserva.
  const cuerpo = '{ "type": "email.delivered",  "data": { "email_id": "re_1" } }'

  it('devuelve el payload parseado cuando la firma casa con los bytes crudos', () => {
    expect(verificador.verificar(Buffer.from(cuerpo), firmar(cuerpo))).toEqual({
      type: 'email.delivered',
      data: { email_id: 're_1' },
    })
  })

  it('rechaza un cuerpo alterado después de firmar', () => {
    const cabeceras = firmar(cuerpo)
    const alterado = cuerpo.replace('delivered', 'bounced')

    expect(() => verificador.verificar(Buffer.from(alterado), cabeceras)).toThrow(
      FirmaInvalidaError,
    )
  })

  it('rechaza el mismo JSON re-serializado: la firma cubre los bytes, no el objeto', () => {
    const cabeceras = firmar(cuerpo)
    const reserializado = JSON.stringify(JSON.parse(cuerpo))

    expect(() => verificador.verificar(Buffer.from(reserializado), cabeceras)).toThrow(
      FirmaInvalidaError,
    )
  })

  it('rechaza una firma hecha con OTRO secreto', () => {
    const ajeno = `whsec_${Buffer.from('otro-secreto-cualquiera-32-bytes').toString('base64')}`

    expect(() =>
      verificador.verificar(Buffer.from(cuerpo), firmar(cuerpo, { secreto: ajeno })),
    ).toThrow(FirmaInvalidaError)
  })

  it('rechaza sin cabeceras de firma', () => {
    expect(() => verificador.verificar(Buffer.from(cuerpo), {})).toThrow(FirmaInvalidaError)
  })

  it('rechaza una firma válida pero caducada: una petición capturada no se puede reenviar', () => {
    const haceDiezMinutos = new Date(Date.now() - 10 * 60_000)

    expect(() =>
      verificador.verificar(Buffer.from(cuerpo), firmar(cuerpo, { cuando: haceDiezMinutos })),
    ).toThrow(FirmaInvalidaError)
  })

  it('sin secreto configurado rechaza TODO, incluso lo bien firmado', () => {
    const sinSecreto = new SvixSignatureVerifier({})

    expect(() => sinSecreto.verificar(Buffer.from(cuerpo), firmar(cuerpo))).toThrow(
      FirmaInvalidaError,
    )
  })

  it('el error es un 401 con código INVALID_SIGNATURE', () => {
    try {
      verificador.verificar(Buffer.from(cuerpo), {})
      expect.unreachable()
    } catch (error) {
      expect(error).toMatchObject({ httpStatus: 401, code: 'INVALID_SIGNATURE' })
    }
  })
})

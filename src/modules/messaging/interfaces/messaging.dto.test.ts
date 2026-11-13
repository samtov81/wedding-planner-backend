import { enviarMensajeSchema, subidaDeAdjuntoSchema } from './messaging.dto'
import { mensajeJson } from './messaging.json'

const ADJUNTO = { key: 'events/e/messages/c/abc.pdf', name: 'plano.pdf' }

describe('enviarMensajeSchema', () => {
  it('acepta un adjunto sin cuerpo y deja el cuerpo en cadena vacía', () => {
    expect(enviarMensajeSchema.parse({ attachment: ADJUNTO })).toEqual({
      body: '',
      attachment: ADJUNTO,
    })
  })

  it('acepta cuerpo con adjunto y cuerpo solo', () => {
    expect(enviarMensajeSchema.parse({ body: ' hola ', attachment: ADJUNTO }).body).toBe('hola')
    expect(enviarMensajeSchema.parse({ body: 'hola' })).toEqual({ body: 'hola' })
  })

  it.each([[{}], [{ body: '  ' }], [{ body: '' }]])('rechaza %o: ni cuerpo ni adjunto', (e) => {
    expect(enviarMensajeSchema.safeParse(e).success).toBe(false)
  })

  it('rechaza más de 2000 puntos de código y acepta 2000 emoji', () => {
    expect(enviarMensajeSchema.safeParse({ body: '😀'.repeat(2000) }).success).toBe(true)
    expect(enviarMensajeSchema.safeParse({ body: '😀'.repeat(2001) }).success).toBe(false)
  })

  it.each([
    [{ key: '', name: 'a' }],
    [{ key: 'k', name: '' }],
    [{ key: 'k'.repeat(501), name: 'a' }],
    [{ key: 'k', name: 'a'.repeat(201) }],
  ])('rechaza el adjunto %o', (attachment) => {
    expect(enviarMensajeSchema.safeParse({ attachment }).success).toBe(false)
  })
})

describe('subidaDeAdjuntoSchema', () => {
  it('acepta tipo y bytes enteros positivos', () => {
    expect(subidaDeAdjuntoSchema.parse({ contentType: 'image/png', bytes: 10 })).toEqual({
      contentType: 'image/png',
      bytes: 10,
    })
  })

  it.each([
    [{ contentType: 'image/png', bytes: 0 }],
    [{ contentType: 'image/png', bytes: 1.5 }],
    [{ bytes: 5 }],
  ])('rechaza %o', (e) => {
    expect(subidaDeAdjuntoSchema.safeParse(e).success).toBe(false)
  })
})

describe('mensajeJson', () => {
  const base = {
    id: 'm',
    conversationId: 'c',
    senderId: 's',
    body: '',
    createdAt: new Date(0),
  }

  it('un mensaje con adjunto lo expone sin key', () => {
    const json = mensajeJson({
      ...base,
      attachment: { name: 'a.pdf', contentType: 'application/pdf', bytes: 3, key: 'secreta' },
    } as never)
    expect(json.attachment).toEqual({ name: 'a.pdf', contentType: 'application/pdf', bytes: 3 })
    expect(JSON.stringify(json)).not.toContain('secreta')
    expect(json.attachment).not.toHaveProperty('key')
  })

  it('sin adjunto, attachment es null', () => {
    expect(mensajeJson({ ...base, attachment: null }).attachment).toBeNull()
  })
})

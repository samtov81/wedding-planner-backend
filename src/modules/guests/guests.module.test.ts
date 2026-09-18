import { getQueueToken } from '@nestjs/bullmq'

import { GuestsModule } from './guests.module'

interface ModuloDinamico {
  providers?: Array<{ provide?: unknown }>
}

describe('GuestsModule', () => {
  /** Los tokens de cola que registra el módulo, leídos de sus imports dinámicos. */
  function colasRegistradas(): unknown[] {
    const imports = (Reflect.getMetadata('imports', GuestsModule) ?? []) as ModuloDinamico[]
    return imports.flatMap((modulo) => (modulo.providers ?? []).map((p) => p.provide))
  }

  it('registra la cola `invitations` y NO la `email` compartida', () => {
    // Registrar `email` aquí le daría a este módulo un worker sobre la cola de
    // otros productores (verify-email, event-invitation).
    const tokens = colasRegistradas()

    expect(tokens).toContain(getQueueToken('invitations'))
    expect(tokens).not.toContain(getQueueToken('email'))
  })
})

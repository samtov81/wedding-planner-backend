import { renderPasswordReset } from './password-reset'

describe('renderPasswordReset', () => {
  const datos = {
    fullName: 'Ana',
    resetUrl: 'https://app.test/reset-password?token=abc123',
    minutosDeValidez: 30,
  }

  it('pone el enlace en el HTML y en el texto plano', async () => {
    const { html, text } = await renderPasswordReset(datos)
    expect(html).toContain('abc123')
    expect(text).toContain('abc123')
  })

  it('el enlace también va como texto visible, no sólo en el botón', async () => {
    const { html } = await renderPasswordReset(datos)
    expect(html.split('abc123').length - 1).toBeGreaterThanOrEqual(2)
  })

  it('dice cuándo caduca y que ignorarlo no cambia nada', async () => {
    const { text } = await renderPasswordReset(datos)
    expect(text).toContain('30 minutes')
    expect(text.toLowerCase()).toContain('ignore')
  })

  it('escapa el nombre en el HTML', async () => {
    const { html } = await renderPasswordReset({ ...datos, fullName: '<script>alert(1)</script>' })
    expect(html).not.toContain('<script>')
  })
})

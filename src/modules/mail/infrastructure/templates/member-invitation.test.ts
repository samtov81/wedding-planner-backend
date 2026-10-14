import { renderMemberInvitation } from './member-invitation'

describe('renderMemberInvitation', () => {
  const datos = {
    fullName: 'Pia',
    invitedByName: 'Ana',
    eventName: 'Boda de Ana',
    role: 'PLANNER' as const,
    appUrl: 'https://app.test/dashboard',
  }

  it('dice quién invita, a qué evento y con qué rol', async () => {
    const { text } = await renderMemberInvitation(datos)
    expect(text).toContain('Pia')
    expect(text).toContain('Ana')
    expect(text).toContain('Boda de Ana')
    expect(text.toLowerCase()).toContain('planner')
  })

  it('enlaza a la app, sin token: se acepta dentro, con sesión', async () => {
    const { html } = await renderMemberInvitation(datos)
    expect(html).toContain('https://app.test/dashboard')
    expect(html).not.toContain('token=')
  })
})

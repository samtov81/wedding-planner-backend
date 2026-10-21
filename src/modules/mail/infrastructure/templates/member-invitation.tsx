import { Body, Button, Container, Head, Heading, Html, render, Text } from '@react-email/components'

interface Props {
  fullName: string
  invitedByName: string
  eventName: string
  role: 'COUPLE' | 'PLANNER'
  appUrl: string
}

function descripcionDelRol(role: Props['role']): string {
  return role === 'COUPLE' ? 'part of the couple' : 'a planner'
}

/**
 * Aviso, no enlace mágico: se acepta dentro de la app con la sesión de la
 * cuenta invitada (spec 2026-10-13 §2), así que el botón sólo lleva a ella.
 */
function MemberInvitation({ fullName, invitedByName, eventName, role, appUrl }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>You&apos;re invited to plan {eventName}</Heading>
          <Text>Hi {fullName},</Text>
          <Text>
            {invitedByName} invited you to join {eventName} as {descripcionDelRol(role)}.
          </Text>
          <Text>Log in to accept or decline the invitation.</Text>
          <Button href={appUrl}>Log in to accept</Button>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderMemberInvitation(
  datos: Props,
): Promise<{ html: string; text: string }> {
  const elemento = <MemberInvitation {...datos} />
  return {
    html: await render(elemento),
    text: await render(elemento, { plainText: true }),
  }
}

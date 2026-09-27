import { Body, Button, Container, Head, Heading, Html, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  guestName: string
  eventName: string
  weddingDate: string
  rsvpUrl: string
}

/** Plantilla de invitación. Se renderiza en el worker, nunca en el hilo HTTP. */
function GuestInvitation({ guestName, eventName, weddingDate, rsvpUrl }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>You are invited to {eventName}</Heading>
          <Text>Dear {guestName},</Text>
          <Text>We would be delighted to have you with us on {weddingDate}.</Text>
          <Button href={rsvpUrl} style={{ padding: '12px 24px' }}>
            Confirm your attendance
          </Button>
          <Text style={{ fontSize: '12px' }}>
            If the button does not work, open this link: {rsvpUrl}
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderGuestInvitation(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <GuestInvitation {...datos} />

  return {
    html: await render(elemento),
    // La versión en texto no es opcional: un correo sólo-HTML puntúa peor en
    // los filtros de spam, y una invitación en la bandeja de spam no existe.
    text: await render(elemento, { plainText: true }),
  }
}

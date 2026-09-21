import { Body, Container, Head, Heading, Html, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  fullName: string
}

function RegistrationAttemptNotice({ fullName }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>Account security notice</Heading>
          <Text>Hi {fullName},</Text>
          <Text>
            We received an attempt to create a wedding planner account using this email address. If this was you,
            your account may already be active — you can log in with your existing credentials.
          </Text>
          <Text>If you did not make this attempt, you can safely ignore this message. No account has been created.</Text>
          <Text style={{ fontSize: '12px', marginTop: '24px', color: '#666' }}>
            If you have any questions, please contact our support team.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderRegistrationAttemptNotice(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <RegistrationAttemptNotice {...datos} />

  return {
    html: await render(elemento),
    text: await render(elemento, { plainText: true }),
  }
}

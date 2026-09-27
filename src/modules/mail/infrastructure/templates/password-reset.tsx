import { Body, Button, Container, Head, Heading, Html, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  fullName: string
  resetUrl: string
  minutosDeValidez: number
}

function PasswordReset({ fullName, resetUrl, minutosDeValidez }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>Reset your password</Heading>
          <Text>Hi {fullName},</Text>
          <Text>We received a request to reset your password. Click the button below to choose a new one.</Text>
          <Button href={resetUrl} style={{ padding: '12px 24px' }}>
            Reset password
          </Button>
          <Text style={{ fontSize: '12px' }}>If the button does not work, open this link: {resetUrl}</Text>
          <Text style={{ fontSize: '12px', marginTop: '24px', color: '#666' }}>
            This link will expire in {minutosDeValidez} minutes and can only be used once. If you did
            not request a password reset, you can safely ignore this email: your password will not change.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderPasswordReset(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <PasswordReset {...datos} />
  return {
    html: await render(elemento),
    text: await render(elemento, { plainText: true }),
  }
}

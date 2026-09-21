import { Body, Button, Container, Head, Heading, Html, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  fullName: string
  verifyUrl: string
}

function EmailVerification({ fullName, verifyUrl }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>Verify your email address</Heading>
          <Text>Hi {fullName},</Text>
          <Text>Thank you for signing up! Please confirm your email address by clicking the button below.</Text>
          <Button href={verifyUrl} style={{ padding: '12px 24px' }}>
            Verify email
          </Button>
          <Text style={{ fontSize: '12px' }}>
            If the button does not work, open this link: {verifyUrl}
          </Text>
          <Text style={{ fontSize: '12px', marginTop: '24px', color: '#666' }}>
            This link will expire in 48 hours.
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderEmailVerification(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <EmailVerification {...datos} />

  return {
    html: await render(elemento),
    text: await render(elemento, { plainText: true }),
  }
}

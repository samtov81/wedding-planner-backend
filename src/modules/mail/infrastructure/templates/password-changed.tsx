import { Body, Container, Head, Heading, Html, Link, Text } from '@react-email/components'
import { render } from '@react-email/components'

interface Props {
  fullName: string
  cambiadoEn: Date
  recoverUrl: string
}

function PasswordChanged({ fullName, cambiadoEn, recoverUrl }: Props) {
  return (
    <Html lang="en">
      <Head />
      <Body style={{ fontFamily: 'Georgia, serif', backgroundColor: '#faf7f2' }}>
        <Container style={{ padding: '32px' }}>
          <Heading>Your password was changed</Heading>
          <Text>Hi {fullName},</Text>
          {/* UTC explícito: el worker no conoce la zona horaria del destinatario. */}
          <Text>The password for your account was changed on {cambiadoEn.toUTCString()}.</Text>
          <Text>For your security, you have been signed out of all devices.</Text>
          <Text>
            If you did not make this change, recover your account now: <Link href={recoverUrl}>{recoverUrl}</Link>
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderPasswordChanged(datos: Props): Promise<{ html: string; text: string }> {
  const elemento = <PasswordChanged {...datos} />
  return {
    html: await render(elemento),
    text: await render(elemento, { plainText: true }),
  }
}

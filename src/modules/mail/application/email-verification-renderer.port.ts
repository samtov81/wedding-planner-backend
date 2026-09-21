export interface EmailVerificationRenderer {
  render(datos: { fullName: string; verifyUrl: string }): Promise<{ html: string; text: string }>
}

export const EMAIL_VERIFICATION_RENDERER = Symbol('EMAIL_VERIFICATION_RENDERER')

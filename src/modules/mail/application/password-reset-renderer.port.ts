export interface PasswordResetRenderer {
  render(datos: {
    fullName: string
    resetUrl: string
    minutosDeValidez: number
  }): Promise<{ html: string; text: string }>
}

export const PASSWORD_RESET_RENDERER = Symbol('PASSWORD_RESET_RENDERER')

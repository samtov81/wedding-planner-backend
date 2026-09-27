export interface PasswordChangedRenderer {
  render(datos: {
    fullName: string
    cambiadoEn: Date
    recoverUrl: string
  }): Promise<{ html: string; text: string }>
}

export const PASSWORD_CHANGED_RENDERER = Symbol('PASSWORD_CHANGED_RENDERER')

export interface RegistrationNoticeRenderer {
  render(datos: { fullName: string }): Promise<{ html: string; text: string }>
}

export const REGISTRATION_NOTICE_RENDERER = Symbol('REGISTRATION_NOTICE_RENDERER')

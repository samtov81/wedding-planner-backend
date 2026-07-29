export interface SendEmailInput {
  to: string;
  subject: string;
  template: string;
  data?: Record<string, unknown>;
}

export interface EmailPort {
  send(input: SendEmailInput): Promise<void>;
}

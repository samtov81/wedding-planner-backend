export interface SendPushToDeviceInput {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface SendPushToTopicInput {
  topic: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface PushPort {
  sendToDevice(input: SendPushToDeviceInput): Promise<void>;
  sendToTopic(input: SendPushToTopicInput): Promise<void>;
}

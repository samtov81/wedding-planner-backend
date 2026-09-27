import type { Socket } from 'socket.io';

export function registerPingEvent(socket: Socket): void {
  socket.on('ping', (payload: unknown, ack?: (response: unknown) => void) => {
    ack?.({ pong: true, receivedAt: new Date().toISOString(), payload });
  });
}

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { WebSocket } from 'ws';
import { TwilioOutputSink } from './twilio-output.sink';

function createMockSocket(readyState = 1) {
  return {
    readyState,
    OPEN: 1,
    send: mock((_data: string) => {}),
  } as unknown as WebSocket & { send: ReturnType<typeof mock> };
}

describe('TwilioOutputSink', () => {
  let socket: ReturnType<typeof createMockSocket>;
  let sink: TwilioOutputSink;

  beforeEach(() => {
    socket = createMockSocket();
    sink = new TwilioOutputSink(socket);
  });

  test('sendToken writes a Twilio text message', () => {
    sink.sendToken('hello', false);
    expect(socket.send).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(socket.send.mock.calls[0][0]);
    expect(payload).toEqual({ type: 'text', token: 'hello', last: false });
  });

  test('sendToken with isLast=true marks the turn complete', () => {
    sink.sendToken('', true);
    const payload = JSON.parse(socket.send.mock.calls[0][0]);
    expect(payload).toEqual({ type: 'text', token: '', last: true });
  });

  test('sendEnd writes a Twilio end message', () => {
    sink.sendEnd();
    const payload = JSON.parse(socket.send.mock.calls[0][0]);
    expect(payload).toEqual({ type: 'end' });
  });

  test('writes are no-ops when the socket is not OPEN', () => {
    const closed = createMockSocket(3); // 3 = CLOSED
    const closedSink = new TwilioOutputSink(closed);
    closedSink.sendToken('x', false);
    closedSink.sendEnd();
    expect(closed.send).not.toHaveBeenCalled();
  });
});

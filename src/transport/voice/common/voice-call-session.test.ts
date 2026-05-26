import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../../test/mocks/pino-logger.mock';
import { VoiceCallSessionImpl } from './voice-call-session';
import type { VoiceOutputSink } from './voice-session.types';

/** Sink that records every call for assertion. */
function createMockSink() {
  return {
    sendToken: mock((_token: string, _last: boolean) => {}),
    sendEnd: mock(() => {}),
  } satisfies VoiceOutputSink & {
    sendToken: ReturnType<typeof mock>;
    sendEnd: ReturnType<typeof mock>;
  };
}

/** Yields the given events from an async generator (mimics executeStreaming). */
function generatorOf(events: unknown[]) {
  return mock(async function* () {
    for (const e of events) yield e;
  });
}

describe('VoiceCallSessionImpl', () => {
  let sink: ReturnType<typeof createMockSink>;
  let orchestrator: { executeStreaming: ReturnType<typeof mock> };

  beforeEach(() => {
    sink = createMockSink();
    orchestrator = { executeStreaming: mock(() => (async function* () {})()) };
  });

  function makeSession(callContext?: string) {
    return new VoiceCallSessionImpl(
      createMockLogger(),
      orchestrator as never,
      sink,
      { sessionId: 'CA123', userId: 42, callContext },
    );
  }

  describe('handleInput - transcript', () => {
    test('ignores partial transcripts (isFinal=false)', async () => {
      const session = makeSession();
      await session.handleInput({
        type: 'transcript',
        text: 'hel',
        isFinal: false,
      });
      expect(orchestrator.executeStreaming).not.toHaveBeenCalled();
      expect(sink.sendToken).not.toHaveBeenCalled();
    });

    test('streams text-delta tokens to the sink', async () => {
      orchestrator.executeStreaming = generatorOf([
        { type: 'text-delta', delta: 'Hi ' },
        { type: 'text-delta', delta: 'there' },
        { type: 'finish' },
      ]);
      const session = makeSession();
      await session.handleInput({
        type: 'transcript',
        text: 'hello',
        isFinal: true,
      });
      const tokenCalls = sink.sendToken.mock.calls;
      expect(tokenCalls[0]).toEqual(['Hi ', false]);
      expect(tokenCalls[1]).toEqual(['there', false]);
      // last marker with empty token on finish
      expect(tokenCalls[2]).toEqual(['', true]);
    });

    test('prepends call context on the first prompt only', async () => {
      orchestrator.executeStreaming = generatorOf([{ type: 'finish' }]);
      const session = makeSession('Calling to confirm dinner');
      await session.handleInput({
        type: 'transcript',
        text: 'hello',
        isFinal: true,
      });
      const firstCallArgs = orchestrator.executeStreaming.mock.calls[0];
      const request = firstCallArgs[1];
      expect(request.message).toContain('Calling to confirm dinner');
      expect(request.message).toContain('hello');

      // Second prompt — context should be gone.
      await session.handleInput({
        type: 'transcript',
        text: 'follow up',
        isFinal: true,
      });
      const secondCallArgs = orchestrator.executeStreaming.mock.calls[1];
      expect(secondCallArgs[1].message).not.toContain(
        'Calling to confirm dinner',
      );
      expect(secondCallArgs[1].message).toBe('follow up');
    });

    test('aborts the previous stream when a new transcript arrives', async () => {
      let firstSignal: AbortSignal | undefined;
      orchestrator.executeStreaming = mock(
        (
          _channel: string,
          _req: unknown,
          opts: { abortSignal: AbortSignal },
        ) => {
          if (!firstSignal) firstSignal = opts.abortSignal;
          return (async function* () {
            // Yield nothing — keep the stream "in flight" until aborted.
            await new Promise(() => {});
          })();
        },
      );
      const session = makeSession();
      const first = session.handleInput({
        type: 'transcript',
        text: 'a',
        isFinal: true,
      });
      // Give the for-await a chance to subscribe.
      await new Promise(resolve => setTimeout(resolve, 10));
      await session.handleInput({
        type: 'transcript',
        text: 'b',
        isFinal: true,
      });
      expect(firstSignal?.aborted).toBe(true);
      // `first` resolves to undefined after the abort propagates; void
      // suppresses the unused-Promise lint warning.
      void first;
    });

    test('sends end after hang_up tool call + delay', async () => {
      orchestrator.executeStreaming = generatorOf([
        { type: 'text-delta', delta: 'Bye!' },
        { type: 'tool-call', toolName: 'hang_up' },
        { type: 'finish' },
      ]);
      const session = makeSession();
      await session.handleInput({
        type: 'transcript',
        text: 'bye',
        isFinal: true,
      });
      // sendEnd is deferred via setTimeout(500); wait for it.
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(sink.sendEnd).toHaveBeenCalledTimes(1);
    });

    test('does not send end when hang_up is not called', async () => {
      orchestrator.executeStreaming = generatorOf([
        { type: 'text-delta', delta: 'ok' },
        { type: 'finish' },
      ]);
      const session = makeSession();
      await session.handleInput({
        type: 'transcript',
        text: 'hi',
        isFinal: true,
      });
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(sink.sendEnd).not.toHaveBeenCalled();
    });

    test('cancels pending sendEnd when session is closed before timeout', async () => {
      orchestrator.executeStreaming = generatorOf([
        { type: 'text-delta', delta: 'Bye!' },
        { type: 'tool-call', toolName: 'hang_up' },
        { type: 'finish' },
      ]);
      const session = makeSession();
      await session.handleInput({
        type: 'transcript',
        text: 'bye',
        isFinal: true,
      });
      // Close before the 500ms delay elapses.
      session.close();
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(sink.sendEnd).not.toHaveBeenCalled();
    });

    test('cancels pending sendEnd when a new transcript arrives before timeout', async () => {
      let callCount = 0;
      orchestrator.executeStreaming = mock(() => {
        callCount++;
        if (callCount === 1) {
          return (async function* () {
            yield { type: 'text-delta', delta: 'Bye!' };
            yield { type: 'tool-call', toolName: 'hang_up' };
            yield { type: 'finish' };
          })();
        }
        return (async function* () {
          yield { type: 'text-delta', delta: 'Wait!' };
          yield { type: 'finish' };
        })();
      });
      const session = makeSession();
      await session.handleInput({
        type: 'transcript',
        text: 'bye',
        isFinal: true,
      });
      // New transcript before the hang-up timer fires.
      await session.handleInput({
        type: 'transcript',
        text: 'actually wait',
        isFinal: true,
      });
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(sink.sendEnd).not.toHaveBeenCalled();
    });
  });

  describe('handleInput - interrupt', () => {
    test('aborts the in-flight stream', async () => {
      let signal: AbortSignal | undefined;
      orchestrator.executeStreaming = mock(
        (_c: string, _r: unknown, opts: { abortSignal: AbortSignal }) => {
          signal = opts.abortSignal;
          return (async function* () {
            await new Promise(() => {});
          })();
        },
      );
      const session = makeSession();
      void session.handleInput({
        type: 'transcript',
        text: 'a',
        isFinal: true,
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      await session.handleInput({ type: 'interrupt' });
      expect(signal?.aborted).toBe(true);
    });

    test('does nothing if no stream is in flight', async () => {
      const session = makeSession();
      // Should not throw, should not invoke sink or orchestrator.
      await session.handleInput({ type: 'interrupt' });
      expect(sink.sendEnd).not.toHaveBeenCalled();
    });
  });

  describe('handleInput - dtmf', () => {
    test('is a no-op apart from logging (for now)', async () => {
      const session = makeSession();
      await session.handleInput({ type: 'dtmf', digit: '5' });
      expect(orchestrator.executeStreaming).not.toHaveBeenCalled();
      expect(sink.sendToken).not.toHaveBeenCalled();
    });
  });

  describe('close', () => {
    test('aborts the in-flight stream', async () => {
      let signal: AbortSignal | undefined;
      orchestrator.executeStreaming = mock(
        (_c: string, _r: unknown, opts: { abortSignal: AbortSignal }) => {
          signal = opts.abortSignal;
          return (async function* () {
            await new Promise(() => {});
          })();
        },
      );
      const session = makeSession();
      void session.handleInput({
        type: 'transcript',
        text: 'a',
        isFinal: true,
      });
      await new Promise(resolve => setTimeout(resolve, 10));
      session.close();
      expect(signal?.aborted).toBe(true);
    });

    test('is idempotent', () => {
      const session = makeSession();
      session.close();
      session.close();
      // No throw == pass.
    });
  });

  describe('error handling', () => {
    test('AbortError from the LLM stream is swallowed', async () => {
      orchestrator.executeStreaming = mock(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        // biome-ignore lint/correctness/useYield: generator that immediately throws to simulate an aborted LLM stream
        return (async function* () {
          throw err;
        })();
      });
      const session = makeSession();
      // Must not reject.
      await expect(
        session.handleInput({ type: 'transcript', text: 'a', isFinal: true }),
      ).resolves.toBeUndefined();
    });

    test('non-abort errors are caught and logged (do not reject)', async () => {
      orchestrator.executeStreaming = mock(() => {
        // biome-ignore lint/correctness/useYield: generator that immediately throws to simulate an LLM error
        return (async function* () {
          throw new Error('LLM blew up');
        })();
      });
      const session = makeSession();
      await expect(
        session.handleInput({ type: 'transcript', text: 'a', isFinal: true }),
      ).resolves.toBeUndefined();
    });
  });
});

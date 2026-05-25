# Voice Transport Abstraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the per-call voice lifecycle from `VoiceGateway` into a transport-agnostic `VoiceCallSession`, and isolate all Twilio-specific code so a future voice transport (Discord voice, native WebRTC, etc.) can be added by writing a new adapter without touching session logic.

**Architecture:** Two-layer split inside `src/transport/voice/`. A `common/` layer owns the conversational lifecycle (prompts in, tokens out, interrupts, hang-up, abort) and exposes an injection-friendly `VoiceOutputSink` interface. A `twilio/` layer owns the Twilio wire protocol — WS handshake, signature validation, ConversationRelay JSON shapes, outbound REST calls, TwiML — and implements `VoiceOutputSink` to bridge session events back onto the WebSocket. The umbrella `voice.module.ts` keeps its current import path so `app.module.ts` does not change.

**Tech Stack:** NestJS 10, Bun runtime, ws (raw WebSocket), Twilio Node SDK 6.x, AI SDK for streaming LLM calls, Pino logger, Biome lint, Bun test.

---

## Background / context for the implementer

Read this section before starting Task 1. The implementer is assumed to know TypeScript and NestJS but may be new to this codebase.

### What we're refactoring (and why)

The current `src/transport/voice/voice.gateway.ts` does five jobs in one file:
1. WS handshake signature validation (Twilio-specific)
2. WS message parsing and dispatch (Twilio's ConversationRelay JSON shapes)
3. Per-call state (abort controllers, hang-up flags, call context)
4. LLM stream consumption via `ChannelOrchestrator.executeStreaming`
5. Token-by-token outbound writes to the WebSocket

`VoiceSessionManager` is a passive `Map<string, VoiceSession>` data bag — it does not own any behavior. All per-call logic lives in gateway methods that take `(client, message)` parameters. The result: the abort/crash bugs we recently shipped fixes for required scattered changes across method boundaries because there was no single object that owned "this call's lifecycle."

The user has stated that a future voice transport (e.g. Discord voice) should be pluggable. So the right axis to split on is **wire protocol vs conversational lifecycle**:
- Wire protocol = Twilio-only stuff (WS frame shapes, signature header, TwiML, REST outbound)
- Conversational lifecycle = transport-agnostic (prompts trigger LLM, interrupts abort the stream, hang-up tool ends the call)

### Target directory layout

```
src/transport/voice/
├── voice.module.ts                  ← unchanged import path; imports both submodules
├── common/
│   ├── voice-session.types.ts       ← VoiceInputEvent, VoiceOutputSink, VoiceCallSession interfaces
│   ├── voice-call-session.ts        ← the behavior class
│   ├── voice-call-session.test.ts
│   ├── voice-session.registry.ts    ← in-memory Map<sessionId, VoiceCallSession>
│   ├── voice-session.registry.test.ts
│   └── voice-session.module.ts      ← provides Registry + factory for VoiceCallSession
└── twilio/
    ├── twilio-voice.module.ts       ← provides all Twilio-specific glue
    ├── twilio.gateway.ts            ← thin WS router (was voice.gateway.ts)
    ├── twilio.gateway.test.ts
    ├── twilio-message.types.ts      ← Twilio ConversationRelay WS message shapes
    ├── twilio-output.sink.ts        ← implements VoiceOutputSink for Twilio WS
    ├── twilio-output.sink.test.ts
    ├── twilio-outbound.service.ts   ← was outbound-call.service.ts
    ├── twilio-outbound.service.test.ts
    ├── twilio-twiml.controller.ts   ← was voice-twiml.controller.ts (path unchanged)
    ├── twilio-call.processor.ts     ← was voice-call.processor.ts
    ├── twilio-call.processor.test.ts
    ├── twilio-signature.guard.ts    ← unchanged
    └── assets/                      ← moved alongside the controller
        └── fallback.mp3
```

The deleted files: `voice.gateway.ts`, `voice-session.manager.ts`, `voice-call.processor.ts`, `voice-twiml.controller.ts`, `outbound-call.service.ts` and their tests. Their content lives in renamed files inside `twilio/`, with the per-call lifecycle code extracted into `common/voice-call-session.ts`.

### Conceptual model of the new design

```
                ┌─────────────────────────────────────────────┐
                │       common/ (transport-agnostic)          │
                │                                             │
                │  VoiceCallSession                           │
                │   .handleInput(event)  ──┐                  │
                │   .close()               │                  │
                │                          │                  │
                │   uses: ChannelOrchestrator.executeStreaming│
                │   emits: tokens → VoiceOutputSink           │
                │                          │                  │
                │  VoiceSessionRegistry    │                  │
                └──────────────────────────┼──────────────────┘
                                           │ implements
                                           ▼
                ┌─────────────────────────────────────────────┐
                │         twilio/ (wire protocol)             │
                │                                             │
                │  TwilioGateway          TwilioOutputSink    │
                │   .handleConnection      .sendToken()       │
                │     parses WS msgs       .sendEnd()         │
                │     creates session       writes WS JSON    │
                │     forwards events                         │
                │                                             │
                │  TwilioTwimlController  TwilioOutbound      │
                │  TwilioCallProcessor    TwilioSignatureGuard│
                └─────────────────────────────────────────────┘
```

A future `discord/` module would provide its own `DiscordGateway` and `DiscordOutputSink`, plus the STT/TTS pipeline that Twilio gives us for free.

### What does NOT change

- `src/channels/` — `VoicePreset`, `HangUpToolFactory`, `ChannelOrchestrator.executeStreaming`, `NullOutput`. The channel layer is correct as-is. (`NullOutput` stays because the channel preset still wants an `OutputHandler`; the actual output happens via the `VoiceOutputSink`, not via `OutputHandler`.)
- `src/app.module.ts` imports `VoiceModule` from `./transport/voice/voice.module` — keep that path stable.
- Routes (`/voice/twiml`, `/voice/status`, `/voice/twiml/fallback`, `/voice/ws`, `/voice/assets/fallback.mp3`) — paths stay the same so Twilio webhook config in the console doesn't break.
- The `voice-calls` BullMQ queue name stays the same.
- `OutboundCallService` is renamed to `TwilioOutboundService` but its `callUser()` signature stays the same (it's called by `VoiceCallFactory` from the channels module).

### Repo conventions to follow

- **Biome formatting**: arrow params without parens in single-arg callbacks (`(err) => ...` is wrong, `err => ...` is right). Run `bun run lint` to catch this.
- **JSDoc**: project CLAUDE.md says JSDoc is required on public functions, helpful on internal ones. Write it.
- **Logger**: use `PinoLogger` from `nestjs-pino`. Call `this.logger.setContext(ClassName.name)` in the constructor. **Never** put a field named `context` in a log payload — pino reserves it.
- **Imports**: project uses node module style (`from '../channel.types'`), Biome will auto-sort.
- **Tests**: `bun:test`, mocks via `mock()`. Existing tests in `src/transport/voice/*.test.ts` are good templates.
- **No emojis** anywhere unless explicitly requested.

### How to verify locally

Available commands (from `package.json`):
- `bun run typecheck` — must pass
- `bun run lint` — must pass
- `bun test` — full suite, currently 341 passing; should still be 341+ when done
- `bun test src/transport/voice/` — voice-only subset
- `bun run build` — compiles to `dist/`

After each commit: `bun run typecheck && bun run lint && bun test` should all pass before moving to the next task.

### About abort handling (subtle, important)

Under Bun, `AbortController.abort()` can throw `AbortError` synchronously because the signal's listeners (installed by the AI SDK) re-throw on cancellation. We already have a `safeAbort()` helper and process-level handlers — the new session class must keep this defensive pattern. **All `.abort()` calls go through `safeAbort()`.**

We also have `prompt.last === false` gating to skip partial transcripts (Twilio sends interim prompts when `speechtimeout` is set). The session must keep this — but expose it via a generic `isFinal: boolean` field on the input event so Discord/other transports can map their own concept of "user finished speaking."

---

## Scope check

This plan is one coherent refactor — the goal is to make voice work with a single LLM core but multiple voice transports. Splitting it into smaller plans would leave the codebase in inconsistent half-states (e.g. half-renamed files, dual session classes coexisting). It should land as one feature branch.

It does NOT include:
- A second voice transport implementation (Discord, etc.) — that's a future plan once this groundwork lands.
- Changes to the text/Telegram side, which is already well-factored.
- Reworking the channel layer or `OutputHandler`.

---

## Task 1: Scaffold `common/` directory and define types

**Files:**
- Create: `src/transport/voice/common/voice-session.types.ts`

- [ ] **Step 1: Create the types file**

```ts
// src/transport/voice/common/voice-session.types.ts

/**
 * An input event flowing from a voice transport into a {@link VoiceCallSession}.
 *
 * The session does not know about specific wire protocols — transports
 * translate their own message shapes into one of these variants.
 */
export type VoiceInputEvent =
  | {
      type: 'transcript';
      /** What the caller said, after STT. */
      text: string;
      /**
       * `true` once the speaker has finished the utterance (e.g. Twilio's
       * `prompt` message with `last: true`). Partial transcripts (`false`)
       * are logged but not sent to the LLM.
       */
      isFinal: boolean;
    }
  | { type: 'interrupt' }
  | { type: 'dtmf'; digit: string };

/**
 * Outbound channel for one voice call. The session pushes events into a
 * sink; each transport supplies an implementation that translates these
 * events into its own wire protocol.
 *
 * Implementations should be cheap to construct (one per call) and must
 * tolerate being called after the underlying connection is gone — they
 * should treat post-close writes as no-ops, not throw.
 */
export interface VoiceOutputSink {
  /**
   * Stream a TTS token to the caller.
   *
   * @param token   Text fragment to speak. Empty string is allowed when
   *                `isLast` is true (signals end-of-turn with no extra text).
   * @param isLast  Whether this is the final token in the current turn.
   */
  sendToken(token: string, isLast: boolean): void;

  /**
   * Signal that the call should end. The transport should close its
   * connection / send any termination message its protocol requires.
   */
  sendEnd(): void;
}

/**
 * Context passed when constructing a {@link VoiceCallSession}.
 *
 * `sessionId` is whatever stable identifier the transport uses (Twilio
 * call SID, Discord voice connection id, etc.) — the session itself does
 * not interpret it beyond using it as a registry key and log field.
 */
export interface VoiceCallSessionContext {
  sessionId: string;
  userId: number;
  /**
   * Optional outbound-call context — for example, "you're calling Jackson
   * to remind him about a meeting." Prepended to the first prompt so the
   * LLM has a reason for the call, then discarded.
   */
  callContext?: string;
}

/**
 * One in-flight voice conversation.
 *
 * Responsibilities:
 * - Convert {@link VoiceInputEvent} into LLM stream invocations
 * - Pump LLM output tokens into the {@link VoiceOutputSink}
 * - Watch for the `hang_up` tool call and signal end after the response
 * - Cancel any in-flight stream on interrupt, close, or new prompt
 */
export interface VoiceCallSession {
  readonly sessionId: string;
  readonly userId: number;
  /**
   * Process an input event from the transport.
   *
   * Returns a promise so the caller can `.catch()` to prevent unhandled
   * rejections — but must never reject for normal control flow (e.g.
   * abort during stream is logged and swallowed).
   */
  handleInput(event: VoiceInputEvent): Promise<void>;
  /**
   * Tear down: abort any in-flight stream and release references.
   * Idempotent — safe to call multiple times.
   */
  close(): void;
}
```

- [ ] **Step 2: Verify file compiles**

Run: `bun run typecheck`
Expected: passes with no errors (file is types-only, no runtime code).

- [ ] **Step 3: Commit**

```bash
git add src/transport/voice/common/voice-session.types.ts
git commit -m "feat(voice): add transport-agnostic session types"
```

---

## Task 2: Implement `VoiceCallSession` (tests first)

**Files:**
- Create: `src/transport/voice/common/voice-call-session.test.ts`
- Create: `src/transport/voice/common/voice-call-session.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/transport/voice/common/voice-call-session.test.ts
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
      await session.handleInput({ type: 'transcript', text: 'hel', isFinal: false });
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
      await session.handleInput({ type: 'transcript', text: 'hello', isFinal: true });
      const tokenCalls = sink.sendToken.mock.calls;
      expect(tokenCalls[0]).toEqual(['Hi ', false]);
      expect(tokenCalls[1]).toEqual(['there', false]);
      // last marker with empty token on finish
      expect(tokenCalls[2]).toEqual(['', true]);
    });

    test('prepends call context on the first prompt only', async () => {
      orchestrator.executeStreaming = generatorOf([{ type: 'finish' }]);
      const session = makeSession('Calling to confirm dinner');
      await session.handleInput({ type: 'transcript', text: 'hello', isFinal: true });
      const firstCallArgs = orchestrator.executeStreaming.mock.calls[0];
      const request = firstCallArgs[1];
      expect(request.message).toContain('Calling to confirm dinner');
      expect(request.message).toContain('hello');

      // Second prompt — context should be gone.
      await session.handleInput({ type: 'transcript', text: 'follow up', isFinal: true });
      const secondCallArgs = orchestrator.executeStreaming.mock.calls[1];
      expect(secondCallArgs[1].message).not.toContain('Calling to confirm dinner');
      expect(secondCallArgs[1].message).toBe('follow up');
    });

    test('aborts the previous stream when a new transcript arrives', async () => {
      let firstSignal: AbortSignal | undefined;
      orchestrator.executeStreaming = mock(
        (_channel: string, _req: unknown, opts: { abortSignal: AbortSignal }) => {
          if (!firstSignal) firstSignal = opts.abortSignal;
          return (async function* () {
            // Yield nothing — keep the stream "in flight" until aborted.
            await new Promise(() => {});
          })();
        },
      );
      const session = makeSession();
      const first = session.handleInput({ type: 'transcript', text: 'a', isFinal: true });
      // Give the for-await a chance to subscribe.
      await new Promise(resolve => setTimeout(resolve, 10));
      await session.handleInput({ type: 'transcript', text: 'b', isFinal: true });
      expect(firstSignal?.aborted).toBe(true);
      // Don't await `first` — it never resolves in this scenario.
      void first;
    });

    test('sends end after hang_up tool call + delay', async () => {
      orchestrator.executeStreaming = generatorOf([
        { type: 'text-delta', delta: 'Bye!' },
        { type: 'tool-call', toolName: 'hang_up' },
        { type: 'finish' },
      ]);
      const session = makeSession();
      await session.handleInput({ type: 'transcript', text: 'bye', isFinal: true });
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
      await session.handleInput({ type: 'transcript', text: 'hi', isFinal: true });
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
      void session.handleInput({ type: 'transcript', text: 'a', isFinal: true });
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
      void session.handleInput({ type: 'transcript', text: 'a', isFinal: true });
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
        return (async function* () {
          const err = new Error('aborted');
          err.name = 'AbortError';
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/transport/voice/common/voice-call-session.test.ts`
Expected: FAIL with "Cannot find module './voice-call-session'" or similar.

- [ ] **Step 3: Implement `VoiceCallSession`**

```ts
// src/transport/voice/common/voice-call-session.ts
import { PinoLogger } from 'nestjs-pino';
import type { ChannelOrchestratorService } from '../../../channels/channel-orchestrator.service';
import { VOICE_CHANNEL_ID } from '../../../channels/presets/voice.preset';
import type {
  VoiceCallSession,
  VoiceCallSessionContext,
  VoiceInputEvent,
  VoiceOutputSink,
} from './voice-session.types';

/** Delay in ms before sending end after hang_up — lets Twilio finish speaking. */
const HANG_UP_DELAY_MS = 500;

/**
 * Transport-agnostic per-call session.
 *
 * Owns the LLM stream lifecycle for one voice call:
 * - Receives input events from a transport (transcript / interrupt / dtmf)
 * - Invokes the LLM via {@link ChannelOrchestratorService.executeStreaming}
 * - Pumps tokens into the injected {@link VoiceOutputSink}
 * - Watches for the `hang_up` tool call and signals end via the sink
 * - Cancels any in-flight stream when a new prompt arrives, on interrupt,
 *   or on {@link close}
 *
 * Construct one per call. The transport's gateway is responsible for
 * choosing when to instantiate (e.g. on a Twilio `setup` message).
 */
export class VoiceCallSessionImpl implements VoiceCallSession {
  readonly sessionId: string;
  readonly userId: number;

  private currentAbort: AbortController | undefined;
  private shouldHangUp = false;
  private pendingCallContext: string | undefined;
  private closed = false;

  constructor(
    private readonly logger: PinoLogger,
    private readonly channelOrchestrator: ChannelOrchestratorService,
    private readonly sink: VoiceOutputSink,
    context: VoiceCallSessionContext,
  ) {
    this.logger.setContext(VoiceCallSessionImpl.name);
    this.sessionId = context.sessionId;
    this.userId = context.userId;
    this.pendingCallContext = context.callContext;
  }

  async handleInput(event: VoiceInputEvent): Promise<void> {
    if (this.closed) {
      this.logger.debug({ sessionId: this.sessionId }, 'Ignoring input on closed session');
      return;
    }
    switch (event.type) {
      case 'transcript':
        await this.onTranscript(event.text, event.isFinal);
        return;
      case 'interrupt':
        this.onInterrupt();
        return;
      case 'dtmf':
        this.logger.debug(
          { sessionId: this.sessionId, digit: event.digit },
          'DTMF received',
        );
        return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.currentAbort) {
      this.safeAbort(this.currentAbort);
      this.currentAbort = undefined;
    }
    this.logger.info({ sessionId: this.sessionId }, 'Voice session closed');
  }

  private async onTranscript(text: string, isFinal: boolean): Promise<void> {
    if (!isFinal) {
      this.logger.debug(
        { sessionId: this.sessionId, text },
        'Skipping partial transcript',
      );
      return;
    }

    // Cancel any in-flight stream from a previous prompt.
    if (this.currentAbort) this.safeAbort(this.currentAbort);

    const abort = new AbortController();
    this.currentAbort = abort;
    this.shouldHangUp = false;

    const userMessage = this.pendingCallContext
      ? `${text}\n\n[Call context: ${this.pendingCallContext}]`
      : text;
    this.pendingCallContext = undefined;

    this.logger.debug({ sessionId: this.sessionId, text }, 'Processing transcript');

    try {
      const stream = this.channelOrchestrator.executeStreaming(
        VOICE_CHANNEL_ID,
        { message: userMessage, userId: this.userId },
        { abortSignal: abort.signal },
      );

      for await (const event of stream) {
        if (abort.signal.aborted) break;
        switch (event.type) {
          case 'text-delta':
            this.sink.sendToken(event.delta, false);
            break;
          case 'tool-call':
            if (event.toolName === 'hang_up') this.shouldHangUp = true;
            break;
          case 'finish':
            this.sink.sendToken('', true);
            if (this.shouldHangUp) {
              setTimeout(() => this.sink.sendEnd(), HANG_UP_DELAY_MS);
            }
            break;
        }
      }
    } catch (error) {
      if ((error as { name?: string })?.name === 'AbortError') {
        this.logger.debug({ sessionId: this.sessionId }, 'Voice stream aborted');
        return;
      }
      this.logger.error(
        { err: error, sessionId: this.sessionId },
        'Error processing transcript',
      );
    } finally {
      if (this.currentAbort === abort) this.currentAbort = undefined;
    }
  }

  private onInterrupt(): void {
    this.logger.debug({ sessionId: this.sessionId }, 'Voice stream interrupted');
    if (this.currentAbort) {
      this.safeAbort(this.currentAbort);
      this.currentAbort = undefined;
    }
  }

  /**
   * Calls `controller.abort()` and swallows any synchronous throw.
   * Under Bun, AbortSignal listeners can throw re-entrantly; we only need
   * the signal to flip and never care about the listener's return value.
   */
  private safeAbort(controller: AbortController): void {
    try {
      controller.abort();
    } catch (err) {
      this.logger.debug({ err }, 'AbortController.abort() threw');
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/transport/voice/common/voice-call-session.test.ts`
Expected: All tests pass (12 expect calls across 11 test cases).

- [ ] **Step 5: Lint + typecheck + full test suite**

Run: `bun run typecheck && bun run lint && bun test`
Expected: All green. Full suite count grows by 11 tests.

- [ ] **Step 6: Commit**

```bash
git add src/transport/voice/common/voice-call-session.ts src/transport/voice/common/voice-call-session.test.ts
git commit -m "feat(voice): add transport-agnostic VoiceCallSession"
```

---

## Task 3: Implement `VoiceSessionRegistry` (tests first)

**Files:**
- Create: `src/transport/voice/common/voice-session.registry.test.ts`
- Create: `src/transport/voice/common/voice-session.registry.ts`

The registry replaces the old `VoiceSessionManager`. It is a simple in-memory map keyed by `sessionId` (whatever the transport uses — Twilio call SID, etc.). The transport is responsible for calling `register()` on setup and `remove()` on disconnect.

- [ ] **Step 1: Write the failing tests**

```ts
// src/transport/voice/common/voice-session.registry.test.ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { createMockLogger } from '../../../test/mocks/pino-logger.mock';
import type { VoiceCallSession } from './voice-session.types';
import { VoiceSessionRegistry } from './voice-session.registry';

function makeFakeSession(sessionId: string): VoiceCallSession {
  return {
    sessionId,
    userId: 42,
    handleInput: async () => {},
    close: () => {},
  };
}

describe('VoiceSessionRegistry', () => {
  let registry: VoiceSessionRegistry;

  beforeEach(() => {
    registry = new VoiceSessionRegistry(createMockLogger());
  });

  test('register + get round-trip', () => {
    const session = makeFakeSession('A');
    registry.register(session);
    expect(registry.get('A')).toBe(session);
  });

  test('get returns undefined for unknown id', () => {
    expect(registry.get('missing')).toBeUndefined();
  });

  test('remove deletes the entry and closes the session', () => {
    let closed = false;
    const session: VoiceCallSession = {
      sessionId: 'A',
      userId: 1,
      handleInput: async () => {},
      close: () => {
        closed = true;
      },
    };
    registry.register(session);
    registry.remove('A');
    expect(registry.get('A')).toBeUndefined();
    expect(closed).toBe(true);
  });

  test('remove is a no-op for unknown id', () => {
    registry.remove('missing');
    expect(registry.size).toBe(0);
  });

  test('size reflects active sessions', () => {
    registry.register(makeFakeSession('A'));
    registry.register(makeFakeSession('B'));
    expect(registry.size).toBe(2);
    registry.remove('A');
    expect(registry.size).toBe(1);
  });

  test('re-registering an id replaces and closes the old session', () => {
    let oldClosed = false;
    const oldSession: VoiceCallSession = {
      sessionId: 'A',
      userId: 1,
      handleInput: async () => {},
      close: () => {
        oldClosed = true;
      },
    };
    const newSession = makeFakeSession('A');
    registry.register(oldSession);
    registry.register(newSession);
    expect(oldClosed).toBe(true);
    expect(registry.get('A')).toBe(newSession);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/transport/voice/common/voice-session.registry.test.ts`
Expected: FAIL with module not found.

- [ ] **Step 3: Implement the registry**

```ts
// src/transport/voice/common/voice-session.registry.ts
import { Injectable } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import type { VoiceCallSession } from './voice-session.types';

/**
 * In-memory registry of active voice call sessions, keyed by session id.
 *
 * Transports register a session on inbound connection setup and remove it
 * when the connection closes. {@link remove} also calls
 * {@link VoiceCallSession.close} so callers don't have to do that twice.
 */
@Injectable()
export class VoiceSessionRegistry {
  private readonly sessions = new Map<string, VoiceCallSession>();

  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(VoiceSessionRegistry.name);
  }

  /**
   * Register a session. If a session with the same id is already
   * registered it is closed and replaced — this handles transport-level
   * reconnects where the old session must release its resources.
   */
  register(session: VoiceCallSession): void {
    const existing = this.sessions.get(session.sessionId);
    if (existing) {
      this.logger.warn(
        { sessionId: session.sessionId },
        'Replacing existing session for id',
      );
      existing.close();
    }
    this.sessions.set(session.sessionId, session);
    this.logger.info(
      { sessionId: session.sessionId, userId: session.userId },
      'Voice session registered',
    );
  }

  get(sessionId: string): VoiceCallSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Remove and close the session for the given id. No-op if not registered.
   */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.close();
    this.sessions.delete(sessionId);
    this.logger.info({ sessionId }, 'Voice session removed');
  }

  get size(): number {
    return this.sessions.size;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/transport/voice/common/voice-session.registry.test.ts`
Expected: All 6 tests pass.

- [ ] **Step 5: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/transport/voice/common/voice-session.registry.ts src/transport/voice/common/voice-session.registry.test.ts
git commit -m "feat(voice): add VoiceSessionRegistry replacing session manager"
```

---

## Task 4: Define `VoiceSessionModule`

**Files:**
- Create: `src/transport/voice/common/voice-session.module.ts`

This module exports the registry. The session class itself is instantiated by transports per-call (not via DI), so we don't provide it here.

- [ ] **Step 1: Create the module**

```ts
// src/transport/voice/common/voice-session.module.ts
import { Module } from '@nestjs/common';
import { ChannelModule } from '../../../channels/channel.module';
import { VoiceSessionRegistry } from './voice-session.registry';

/**
 * Common voice infrastructure shared across voice transport adapters.
 *
 * Exports the session registry and re-exports {@link ChannelModule} so
 * adapter modules can inject {@link ChannelOrchestratorService} when
 * constructing per-call sessions.
 */
@Module({
  imports: [ChannelModule],
  providers: [VoiceSessionRegistry],
  exports: [VoiceSessionRegistry, ChannelModule],
})
export class VoiceSessionModule {}
```

- [ ] **Step 2: Typecheck**

Run: `bun run typecheck`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/transport/voice/common/voice-session.module.ts
git commit -m "feat(voice): add VoiceSessionModule exposing registry"
```

---

## Task 5: Scaffold `twilio/` directory — move existing files

This task is mechanical renames. No behavior changes — verify nothing breaks before changing anything else.

**Files:**
- Move: `src/transport/voice/twilio-signature.guard.ts` → `src/transport/voice/twilio/twilio-signature.guard.ts`
- Move: `src/transport/voice/outbound-call.service.ts` → `src/transport/voice/twilio/twilio-outbound.service.ts`
- Move: `src/transport/voice/outbound-call.service.test.ts` → `src/transport/voice/twilio/twilio-outbound.service.test.ts`
- Move: `src/transport/voice/voice-call.processor.ts` → `src/transport/voice/twilio/twilio-call.processor.ts`
- Move: `src/transport/voice/voice-call.processor.test.ts` → `src/transport/voice/twilio/twilio-call.processor.test.ts`
- Move: `src/transport/voice/voice-twiml.controller.ts` → `src/transport/voice/twilio/twilio-twiml.controller.ts`
- Move: `src/transport/voice/assets/` → `src/transport/voice/twilio/assets/`

- [ ] **Step 1: Create the directory and move files via git**

```bash
mkdir -p src/transport/voice/twilio
git mv src/transport/voice/twilio-signature.guard.ts src/transport/voice/twilio/twilio-signature.guard.ts
git mv src/transport/voice/outbound-call.service.ts src/transport/voice/twilio/twilio-outbound.service.ts
git mv src/transport/voice/outbound-call.service.test.ts src/transport/voice/twilio/twilio-outbound.service.test.ts
git mv src/transport/voice/voice-call.processor.ts src/transport/voice/twilio/twilio-call.processor.ts
git mv src/transport/voice/voice-call.processor.test.ts src/transport/voice/twilio/twilio-call.processor.test.ts
git mv src/transport/voice/voice-twiml.controller.ts src/transport/voice/twilio/twilio-twiml.controller.ts
git mv src/transport/voice/assets src/transport/voice/twilio/assets
```

- [ ] **Step 2: Rename classes inside the moved files**

In `src/transport/voice/twilio/twilio-outbound.service.ts`:
- Rename `class OutboundCallService` to `class TwilioOutboundService`

In `src/transport/voice/twilio/twilio-outbound.service.test.ts`:
- Update import: `import { TwilioOutboundService } from './twilio-outbound.service';`
- Update local variable + describe block names.

In `src/transport/voice/twilio/twilio-call.processor.ts`:
- Rename `class VoiceCallProcessor` to `class TwilioCallProcessor`
- Update import: `import { TwilioOutboundService } from './twilio-outbound.service';`
- Update the constructor parameter type accordingly.
- Keep `@Processor('voice-calls')` — the queue name stays the same.

In `src/transport/voice/twilio/twilio-call.processor.test.ts`:
- Update import + describe block to `TwilioCallProcessor`.

In `src/transport/voice/twilio/twilio-twiml.controller.ts`:
- Rename `class VoiceTwimlController` to `class TwilioTwimlController`
- Update the asset-path resolver `join(__dirname, 'assets', 'fallback.mp3')` is still correct because `assets/` moved with the file. Verify visually.

- [ ] **Step 3: Update `src/transport/voice/voice.module.ts` imports temporarily**

Edit `src/transport/voice/voice.module.ts` to keep it compiling — update the imports to point at the new file paths and renamed classes. Leave class names referenced in the providers/controllers/exports arrays updated to the new names. The full final module will be replaced in Task 9, this is a temporary patch.

```ts
// src/transport/voice/voice.module.ts (interim)
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { ChannelModule } from '../../channels/channel.module';
import { AgentDispatcher } from '../../dispatcher';
import { TwilioOutboundService } from './twilio/twilio-outbound.service';
import { TwilioSignatureGuard } from './twilio/twilio-signature.guard';
import { TwilioCallProcessor } from './twilio/twilio-call.processor';
import { TwilioTwimlController } from './twilio/twilio-twiml.controller';
import { VoiceGateway } from './voice.gateway';
import { VoiceSessionManager } from './voice-session.manager';

@Module({
  imports: [
    ConfigModule,
    ChannelModule,
    BullModule.registerQueue({
      name: 'voice-calls',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    }),
  ],
  controllers: [TwilioTwimlController],
  providers: [
    VoiceGateway,
    VoiceSessionManager,
    TwilioOutboundService,
    TwilioCallProcessor,
    TwilioSignatureGuard,
  ],
  exports: [TwilioOutboundService],
})
export class VoiceModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: AgentDispatcher,
    @InjectQueue('voice-calls') private readonly voiceCallsQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerQueue('voice-calls', this.voiceCallsQueue);
  }
}
```

Also update the still-existing `src/transport/voice/voice.gateway.ts` to import from the new path:
- `import { VoiceSessionManager } from './voice-session.manager';` — unchanged for now (still in old location).
- No other import changes needed in gateway.

- [ ] **Step 4: Update any callers of `OutboundCallService` elsewhere in the repo**

Run: `grep -rn 'OutboundCallService\|VoiceCallProcessor\|VoiceTwimlController' src/ --include='*.ts'`

For every match, rename to the new class name. As of the time of writing, the expected matches are:
- `src/channels/tools/voice-call.factory.ts` — uses `OutboundCallService` → rename to `TwilioOutboundService` and update the import path to `'../../transport/voice/twilio/twilio-outbound.service'`.
- `src/channels/tools/voice-call.factory.test.ts` — same.

Verify with grep that no other matches remain.

- [ ] **Step 5: Verify everything still works**

```bash
bun run typecheck
bun run lint
bun test
```

Expected: All green, same test count as before this task (renames are behavior-preserving).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(voice): move Twilio-specific files into twilio/ subdir"
```

---

## Task 6: Implement `TwilioOutputSink` (tests first)

**Files:**
- Create: `src/transport/voice/twilio/twilio-output.sink.test.ts`
- Create: `src/transport/voice/twilio/twilio-output.sink.ts`
- Create: `src/transport/voice/twilio/twilio-message.types.ts`

The Twilio sink takes a `ws.WebSocket` in the constructor and translates session events into the Twilio ConversationRelay JSON shapes.

- [ ] **Step 1: Write the failing tests**

```ts
// src/transport/voice/twilio/twilio-output.sink.test.ts
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

  test('sendToken with last=true marks the turn complete', () => {
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/transport/voice/twilio/twilio-output.sink.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the Twilio message type definitions**

```ts
// src/transport/voice/twilio/twilio-message.types.ts

/**
 * Twilio ConversationRelay WebSocket message types.
 *
 * Spec: https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
 *
 * Inbound (server → us) and outbound (us → server) variants are split for
 * clarity. The session/sink layer never sees these — only {@link TwilioGateway}
 * and {@link TwilioOutputSink} touch them.
 */

/** Initial message from Twilio after WS connect. */
export interface TwilioSetupMessage {
  type: 'setup';
  callSid: string;
  sessionId?: string;
  accountSid?: string;
  from: string;
  to: string;
  direction: string;
  customParameters?: Record<string, string>;
}

/** Caller speech, post-STT. */
export interface TwilioPromptMessage {
  type: 'prompt';
  voicePrompt: string;
  /** False for partial transcripts when `speechtimeout` / `partialPrompts` are set. */
  last?: boolean;
  lang?: string;
}

export interface TwilioInterruptMessage {
  type: 'interrupt';
  utteranceUntilInterrupt?: string;
  durationUntilInterruptMs?: number;
}

export interface TwilioDtmfMessage {
  type: 'dtmf';
  digit: string;
}

export interface TwilioErrorMessage {
  type: 'error';
  description?: string;
}

export type TwilioInboundMessage =
  | TwilioSetupMessage
  | TwilioPromptMessage
  | TwilioInterruptMessage
  | TwilioDtmfMessage
  | TwilioErrorMessage
  | { type: string };

/** TTS token frame written back to Twilio. */
export interface TwilioTextOutbound {
  type: 'text';
  token: string;
  last: boolean;
}

/** End-of-session frame. Twilio closes the WS and hangs up. */
export interface TwilioEndOutbound {
  type: 'end';
}

export type TwilioOutboundMessage = TwilioTextOutbound | TwilioEndOutbound;
```

- [ ] **Step 4: Implement the sink**

```ts
// src/transport/voice/twilio/twilio-output.sink.ts
import type { WebSocket } from 'ws';
import type { VoiceOutputSink } from '../common/voice-session.types';
import type { TwilioOutboundMessage } from './twilio-message.types';

/**
 * {@link VoiceOutputSink} implementation for Twilio ConversationRelay.
 *
 * Owns one WebSocket and translates session-level output events into the
 * Twilio JSON wire format. Writes are no-ops when the socket is not OPEN
 * so a session that finishes after the caller hangs up doesn't blow up.
 *
 * Constructed per call by {@link TwilioGateway} on the `setup` message.
 */
export class TwilioOutputSink implements VoiceOutputSink {
  constructor(private readonly socket: WebSocket) {}

  sendToken(token: string, isLast: boolean): void {
    this.send({ type: 'text', token, last: isLast });
  }

  sendEnd(): void {
    this.send({ type: 'end' });
  }

  private send(message: TwilioOutboundMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/transport/voice/twilio/twilio-output.sink.test.ts`
Expected: All 4 tests pass.

- [ ] **Step 6: Typecheck + lint**

Run: `bun run typecheck && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/transport/voice/twilio/twilio-output.sink.ts src/transport/voice/twilio/twilio-output.sink.test.ts src/transport/voice/twilio/twilio-message.types.ts
git commit -m "feat(voice): add TwilioOutputSink + message types"
```

---

## Task 7: Rewrite the gateway as `TwilioGateway` (tests first)

The new gateway is a thin router: validate signature on upgrade, parse JSON, translate Twilio messages into `VoiceInputEvent` calls on the session, register/remove from the registry. All session state lives on the `VoiceCallSessionImpl` instance.

**Files:**
- Create: `src/transport/voice/twilio/twilio.gateway.test.ts`
- Create: `src/transport/voice/twilio/twilio.gateway.ts`
- Delete: `src/transport/voice/voice.gateway.ts`
- Delete: `src/transport/voice/voice.gateway.test.ts`
- Delete: `src/transport/voice/voice-session.manager.ts`
- Delete: `src/transport/voice/voice-session.manager.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/transport/voice/twilio/twilio.gateway.test.ts
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../../test/mocks/pino-logger.mock';
import type { VoiceCallSession } from '../common/voice-session.types';
import { TwilioGateway } from './twilio.gateway';

function createMockSocket() {
  return {
    readyState: 1,
    OPEN: 1,
    send: mock(() => {}),
    on: mock((_e: string, _cb: (...args: unknown[]) => void) => {}),
    close: mock((_code: number, _reason: string) => {}),
  };
}

function createMockConfig(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'voice.userId': 42,
    'twilio.authToken': '',
    'voice.serverUrl': 'https://murph.test',
  };
  return { get: mock((key: string) => overrides[key] ?? defaults[key]) };
}

function makeGateway(
  registry = { register: mock(() => {}), get: mock(() => undefined as VoiceCallSession | undefined), remove: mock(() => {}) },
  orchestrator = { executeStreaming: mock(() => (async function* () {})()) },
  config = createMockConfig(),
) {
  return {
    gateway: new TwilioGateway(
      createMockLogger(),
      config as never,
      registry as never,
      orchestrator as never,
    ),
    registry,
    orchestrator,
    config,
  };
}

describe('TwilioGateway', () => {
  describe('handleConnection signature validation', () => {
    test('allows connection when authToken is unset (dev fallback)', () => {
      const { gateway } = makeGateway();
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      expect(socket.close).not.toHaveBeenCalled();
      expect(socket.on).toHaveBeenCalledWith('message', expect.anything());
    });

    test('closes the socket when authToken set and signature missing', () => {
      const { gateway } = makeGateway(undefined, undefined, createMockConfig({ 'twilio.authToken': 'tok' }));
      const socket = createMockSocket();
      const request = { headers: {}, socket: { remoteAddress: '1.2.3.4' } } as never;
      gateway.handleConnection(socket as never, request);
      expect(socket.close).toHaveBeenCalled();
      expect(socket.on).not.toHaveBeenCalled();
    });
  });

  describe('message dispatch', () => {
    test('setup creates a session and registers it', () => {
      const registry = { register: mock(() => {}), get: mock(() => undefined), remove: mock(() => {}) };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      handler(JSON.stringify({
        type: 'setup',
        callSid: 'CA1',
        from: '+1',
        to: '+2',
        direction: 'inbound',
        customParameters: { callContext: 'check-in' },
      }));
      expect(registry.register).toHaveBeenCalledTimes(1);
      const registered = registry.register.mock.calls[0][0] as VoiceCallSession;
      expect(registered.sessionId).toBe('CA1');
      expect(registered.userId).toBe(42);
    });

    test('prompt forwards transcript to the session', async () => {
      const session: VoiceCallSession & { handleInput: ReturnType<typeof mock> } = {
        sessionId: 'CA1',
        userId: 42,
        handleInput: mock(async (_e: unknown) => {}),
        close: () => {},
      };
      const registry = { register: mock(() => {}), get: mock(() => session), remove: mock(() => {}) };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      // Setup first so the gateway has a sessionId for this socket.
      handler(JSON.stringify({ type: 'setup', callSid: 'CA1', from: '+1', to: '+2', direction: 'inbound' }));
      handler(JSON.stringify({ type: 'prompt', voicePrompt: 'hello', last: true }));
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(session.handleInput).toHaveBeenCalledWith({
        type: 'transcript',
        text: 'hello',
        isFinal: true,
      });
    });

    test('prompt isFinal defaults to true if last is omitted', async () => {
      const session: VoiceCallSession & { handleInput: ReturnType<typeof mock> } = {
        sessionId: 'CA1', userId: 42, handleInput: mock(async () => {}), close: () => {},
      };
      const registry = { register: mock(() => {}), get: mock(() => session), remove: mock(() => {}) };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      handler(JSON.stringify({ type: 'setup', callSid: 'CA1', from: '+1', to: '+2', direction: 'inbound' }));
      handler(JSON.stringify({ type: 'prompt', voicePrompt: 'hi' }));
      await new Promise(resolve => setTimeout(resolve, 5));
      const event = (session.handleInput.mock.calls[0] as unknown[])[0] as { isFinal: boolean };
      expect(event.isFinal).toBe(true);
    });

    test('interrupt forwards to the session', async () => {
      const session: VoiceCallSession & { handleInput: ReturnType<typeof mock> } = {
        sessionId: 'CA1', userId: 42, handleInput: mock(async () => {}), close: () => {},
      };
      const registry = { register: mock(() => {}), get: mock(() => session), remove: mock(() => {}) };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      handler(JSON.stringify({ type: 'setup', callSid: 'CA1', from: '+1', to: '+2', direction: 'inbound' }));
      handler(JSON.stringify({ type: 'interrupt' }));
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(session.handleInput).toHaveBeenCalledWith({ type: 'interrupt' });
    });

    test('handleDisconnect removes the session from the registry', () => {
      const registry = { register: mock(() => {}), get: mock(() => undefined), remove: mock(() => {}) };
      const { gateway } = makeGateway(registry);
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      handler(JSON.stringify({ type: 'setup', callSid: 'CA9', from: '+1', to: '+2', direction: 'inbound' }));
      gateway.handleDisconnect(socket as never);
      expect(registry.remove).toHaveBeenCalledWith('CA9');
    });

    test('malformed JSON does not throw or close the socket', () => {
      const { gateway } = makeGateway();
      const socket = createMockSocket();
      gateway.handleConnection(socket as never, undefined);
      const handler = socket.on.mock.calls[0][1] as (d: string) => void;
      expect(() => handler('not json')).not.toThrow();
      expect(socket.close).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/transport/voice/twilio/twilio.gateway.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the new gateway**

```ts
// src/transport/voice/twilio/twilio.gateway.ts
import type { IncomingMessage } from 'node:http';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { PinoLogger } from 'nestjs-pino';
import { validateRequest } from 'twilio';
import type { WebSocket } from 'ws';
import { ChannelOrchestratorService } from '../../../channels/channel-orchestrator.service';
import { VoiceCallSessionImpl } from '../common/voice-call-session';
import { VoiceSessionRegistry } from '../common/voice-session.registry';
import type {
  VoiceCallSession,
  VoiceInputEvent,
} from '../common/voice-session.types';
import type {
  TwilioInboundMessage,
  TwilioPromptMessage,
  TwilioSetupMessage,
} from './twilio-message.types';
import { TwilioOutputSink } from './twilio-output.sink';

/** WebSocket close code 1008 (RFC 6455) — message violates server policy. */
const WS_CLOSE_POLICY_VIOLATION = 1008;

/**
 * Twilio-specific WebSocket gateway for ConversationRelay.
 *
 * Responsibilities (Twilio-specific only):
 * - Validate `X-Twilio-Signature` on the WS upgrade
 * - Parse the ConversationRelay JSON message envelope
 * - On `setup`: create a {@link VoiceCallSessionImpl}, register it
 * - On `prompt` / `interrupt` / `dtmf`: forward as {@link VoiceInputEvent}
 * - On disconnect: remove the session from the registry
 *
 * All conversational lifecycle (LLM streaming, abort, hang-up timing)
 * lives in {@link VoiceCallSessionImpl}, not here.
 */
@WebSocketGateway({ path: '/voice/ws' })
export class TwilioGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly userId: number;
  private readonly authToken: string;
  private readonly wsUrl: string;
  /** WS client → sessionId mapping for disconnect cleanup. */
  private readonly clientToSessionId = new WeakMap<WebSocket, string>();

  constructor(
    private readonly logger: PinoLogger,
    private readonly configService: ConfigService,
    private readonly registry: VoiceSessionRegistry,
    private readonly channelOrchestrator: ChannelOrchestratorService,
  ) {
    this.logger.setContext(TwilioGateway.name);
    this.userId = this.configService.get<number>('voice.userId');
    this.authToken = this.configService.get<string>('twilio.authToken');
    const serverUrl = this.configService.get<string>('voice.serverUrl') ?? '';
    this.wsUrl = `${serverUrl.replace(/^http/, 'ws')}/voice/ws`;
  }

  handleConnection(client: WebSocket, request?: IncomingMessage): void {
    if (!this.verifySignature(request)) {
      this.logger.warn(
        { ip: request?.socket?.remoteAddress },
        'Rejected WebSocket handshake with invalid Twilio signature',
      );
      client.close(WS_CLOSE_POLICY_VIOLATION, 'Invalid Twilio signature');
      return;
    }

    this.logger.info('Voice WebSocket connected');

    client.on('message', (data: Buffer | string) => {
      try {
        const message = JSON.parse(
          typeof data === 'string' ? data : data.toString(),
        ) as TwilioInboundMessage;
        this.dispatch(client, message);
      } catch (error) {
        this.logger.error({ err: error }, 'Failed to parse WebSocket message');
      }
    });
  }

  handleDisconnect(client: WebSocket): void {
    const sessionId = this.clientToSessionId.get(client);
    if (sessionId) {
      this.logger.info({ sessionId }, 'Voice call disconnected');
      this.registry.remove(sessionId);
      this.clientToSessionId.delete(client);
    }
  }

  /**
   * Routes incoming Twilio messages. Async handler calls are .catch()-ed
   * so a rejection cannot escape into Node's uncaught-rejection path.
   */
  private dispatch(client: WebSocket, message: TwilioInboundMessage): void {
    switch (message.type) {
      case 'setup':
        this.onSetup(client, message as TwilioSetupMessage);
        return;
      case 'prompt': {
        const m = message as TwilioPromptMessage;
        this.forwardToSession(client, {
          type: 'transcript',
          text: m.voicePrompt,
          // Treat missing `last` as `true` for safety — older protocol versions
          // omit it and we'd rather process than silently drop.
          isFinal: m.last !== false,
        });
        return;
      }
      case 'interrupt':
        this.forwardToSession(client, { type: 'interrupt' });
        return;
      case 'dtmf':
        this.forwardToSession(client, {
          type: 'dtmf',
          digit: (message as { digit: string }).digit,
        });
        return;
      case 'error':
        this.logger.error({ message }, 'Twilio ConversationRelay error');
        return;
      default:
        this.logger.debug({ type: message.type }, 'Unhandled message type');
    }
  }

  private onSetup(client: WebSocket, message: TwilioSetupMessage): void {
    const callContext = message.customParameters?.callContext;
    this.logger.info(
      {
        callSid: message.callSid,
        from: message.from,
        to: message.to,
        direction: message.direction,
        hasContext: !!callContext,
      },
      'Voice call setup',
    );
    const sink = new TwilioOutputSink(client);
    const session: VoiceCallSession = new VoiceCallSessionImpl(
      this.logger,
      this.channelOrchestrator,
      sink,
      { sessionId: message.callSid, userId: this.userId, callContext },
    );
    this.registry.register(session);
    this.clientToSessionId.set(client, message.callSid);
  }

  private forwardToSession(client: WebSocket, event: VoiceInputEvent): void {
    const sessionId = this.clientToSessionId.get(client);
    if (!sessionId) {
      this.logger.warn({ eventType: event.type }, 'Input before setup, dropping');
      return;
    }
    const session = this.registry.get(sessionId);
    if (!session) {
      this.logger.warn({ sessionId }, 'Session missing in registry');
      return;
    }
    session.handleInput(event).catch(err => {
      this.logger.error({ err, sessionId }, 'session.handleInput rejected');
    });
  }

  /**
   * Validates the `X-Twilio-Signature` header on the WS upgrade request.
   * Returns true if validation is disabled (no authToken — dev fallback).
   */
  private verifySignature(request?: IncomingMessage): boolean {
    if (!this.authToken) {
      this.logger.warn(
        'TWILIO_AUTH_TOKEN not set — accepting WS handshake without signature validation',
      );
      return true;
    }
    if (!request) return false;
    const signature = request.headers['x-twilio-signature'];
    const value = Array.isArray(signature) ? signature[0] : signature;
    if (!value) return false;
    return validateRequest(this.authToken, value, this.wsUrl, {});
  }
}
```

- [ ] **Step 4: Delete the obsolete files**

```bash
git rm src/transport/voice/voice.gateway.ts
git rm src/transport/voice/voice.gateway.test.ts
git rm src/transport/voice/voice-session.manager.ts
git rm src/transport/voice/voice-session.manager.test.ts
```

- [ ] **Step 5: Run tests + typecheck + lint**

Run: `bun test src/transport/voice/twilio/twilio.gateway.test.ts`
Expected: 7 tests pass.

Run: `bun run typecheck && bun run lint`
Expected: clean. (The `voice.module.ts` from Task 5 still references `VoiceGateway` and `VoiceSessionManager` — these will compile-error here. Update those references inline as part of this step.)

In `src/transport/voice/voice.module.ts`, replace:
- `import { VoiceGateway } from './voice.gateway';` → `import { TwilioGateway } from './twilio/twilio.gateway';`
- `import { VoiceSessionManager } from './voice-session.manager';` → `import { VoiceSessionRegistry } from './common/voice-session.registry';`
- In `providers: [...]` — replace `VoiceGateway, VoiceSessionManager,` with `TwilioGateway, VoiceSessionRegistry,`.

Re-run: `bun run typecheck && bun run lint && bun test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(voice): replace VoiceGateway with thin TwilioGateway over session"
```

---

## Task 8: Define `TwilioVoiceModule` and refactor umbrella `VoiceModule`

Now that all Twilio-specific bits live under `twilio/` and the common bits live under `common/`, give each its own module. `voice.module.ts` becomes an umbrella that imports both.

**Files:**
- Create: `src/transport/voice/twilio/twilio-voice.module.ts`
- Modify: `src/transport/voice/voice.module.ts`

- [ ] **Step 1: Create `TwilioVoiceModule`**

```ts
// src/transport/voice/twilio/twilio-voice.module.ts
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Queue } from 'bullmq';
import { AgentDispatcher } from '../../../dispatcher';
import { VoiceSessionModule } from '../common/voice-session.module';
import { TwilioCallProcessor } from './twilio-call.processor';
import { TwilioGateway } from './twilio.gateway';
import { TwilioOutboundService } from './twilio-outbound.service';
import { TwilioSignatureGuard } from './twilio-signature.guard';
import { TwilioTwimlController } from './twilio-twiml.controller';

/**
 * Twilio-specific voice transport.
 *
 * Provides the WS gateway, TwiML controller, outbound REST client, and
 * the BullMQ processor that consumes the `voice-calls` queue. Depends
 * on {@link VoiceSessionModule} for the per-call session registry.
 *
 * Adding another voice transport (Discord voice, etc.) means creating
 * a sibling module that also imports {@link VoiceSessionModule}.
 */
@Module({
  imports: [
    ConfigModule,
    VoiceSessionModule,
    BullModule.registerQueue({
      name: 'voice-calls',
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    }),
  ],
  controllers: [TwilioTwimlController],
  providers: [
    TwilioGateway,
    TwilioOutboundService,
    TwilioCallProcessor,
    TwilioSignatureGuard,
  ],
  exports: [TwilioOutboundService],
})
export class TwilioVoiceModule implements OnModuleInit {
  constructor(
    private readonly dispatcher: AgentDispatcher,
    @InjectQueue('voice-calls') private readonly voiceCallsQueue: Queue,
  ) {}

  onModuleInit(): void {
    this.dispatcher.registerQueue('voice-calls', this.voiceCallsQueue);
  }
}
```

- [ ] **Step 2: Rewrite the umbrella module**

Replace the whole contents of `src/transport/voice/voice.module.ts`:

```ts
// src/transport/voice/voice.module.ts
import { Module } from '@nestjs/common';
import { VoiceSessionModule } from './common/voice-session.module';
import { TwilioVoiceModule } from './twilio/twilio-voice.module';
import { TwilioOutboundService } from './twilio/twilio-outbound.service';

/**
 * Umbrella module that bundles every voice transport.
 *
 * Currently provides Twilio only. To add another voice transport, declare
 * a sibling module under `transport/voice/<name>/` and import it here.
 *
 * Re-exports {@link TwilioOutboundService} so the channels module's
 * `voice-call.factory` can keep its existing import path.
 */
@Module({
  imports: [VoiceSessionModule, TwilioVoiceModule],
  exports: [TwilioVoiceModule],
})
export class VoiceModule {}
```

- [ ] **Step 3: Update `voice-call.factory.ts` if its import path changed in Task 5**

Check `src/channels/tools/voice-call.factory.ts` — its import for `TwilioOutboundService` should be either from `'../../transport/voice/twilio/twilio-outbound.service'` (direct) or `'../../transport/voice'` (re-export via index).

If the factory currently uses a `'../../transport/voice'` import that no longer works, either update to the direct path or add a re-export in `src/transport/voice/index.ts`. Either is fine; pick whichever matches what the rest of the repo does.

- [ ] **Step 4: Run full verification**

Run: `bun run typecheck && bun run lint && bun test`
Expected: All green. Test count should be 341 (pre-refactor) + 11 (session) + 6 (registry) + 4 (sink) + 7 (gateway) − 9 (old voice.gateway.test.ts had 9) − 4 (old voice-session.manager.test.ts had 4) ≈ 356 tests.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(voice): split into TwilioVoiceModule + umbrella VoiceModule"
```

---

## Task 9: End-to-end smoke verification

This is a manual verification step — no code changes. Run the app and confirm the route table looks right.

- [ ] **Step 1: Start the app**

```bash
bun run dev
```

Wait until you see `Nest application successfully started` and `Murph listening on [::]:3000` in the logs.

- [ ] **Step 2: Verify route mapping**

Look for these lines in the startup output:

```
Mapped {/voice/twiml, POST} route
Mapped {/voice/status, POST} route
Mapped {/voice/assets/fallback.mp3, GET} route
Mapped {/voice/twiml/fallback, POST} route
```

All four should be present. If any are missing, `TwilioTwimlController` isn't wired into `TwilioVoiceModule` correctly.

- [ ] **Step 3: Verify health endpoint**

```bash
curl http://localhost:3000/health/liveness
```

Expected: HTTP 200.

- [ ] **Step 4: Kill the dev server, run full test suite once more**

Run: `bun test`
Expected: all green, no flakes.

- [ ] **Step 5: Final commit (if anything was tweaked during smoke)**

If no changes were needed, skip this step.

```bash
git add -A
git commit -m "chore(voice): smoke-verified post-refactor"
```

---

## Post-implementation notes

After the plan is executed, the codebase has the following properties:

- **Per-call lifecycle isolated**: All abort, prompt-gating, hang-up, and streaming logic lives in `VoiceCallSessionImpl`, testable in isolation without a WebSocket.
- **Twilio decoupled**: The session class does not import anything Twilio-specific. The gateway, sink, signature guard, TwiML controller, outbound REST client, and BullMQ processor are all confined to `twilio/`.
- **Pluggable transport**: A future Discord (or other) voice transport adds a sibling directory under `voice/`, implements `VoiceOutputSink`, builds its own gateway, and reuses `VoiceCallSessionImpl` directly. Its own concerns (Discord WS protocol, opus audio frames, STT/TTS pipeline) stay within its own module.
- **No public API changes**: External imports of `VoiceModule` and `TwilioOutboundService` keep working. Webhook routes are unchanged. The `voice-calls` BullMQ queue name is unchanged.

Things explicitly left for a future plan:
- Adding a second voice transport (e.g. Discord) — needs to happen with a real use case driving it.
- An STT/TTS abstraction (would only matter for non-Twilio transports that don't get them for free).
- Persisting voice session state across reconnects — currently each new WS connection is a new session.

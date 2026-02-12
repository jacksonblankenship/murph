# Murph

A personal AI assistant built on NestJS, powered by Claude. Connects via Telegram and voice calls, backed by a filesystem markdown vault with vector search.

## Architecture

```mermaid
graph LR
  %% ─── External ───
  Telegram["Telegram"]
  Twilio["Twilio"]
  Anthropic["Anthropic"]

  %% ─── Message processing pipeline ───
  TelegramUpdate["TelegramUpdate"]
  InboundService["InboundService"]
  InboundProcessor["InboundProcessor"]
  ChannelOrchestrator["ChannelOrchestrator"]
  BroadcastHandler["BroadcastHandler"]

  %% ─── Voice path ───
  VoiceGateway["VoiceGateway"]
  VoiceTwimlController["VoiceTwimlController"]
  VoiceCallProcessor["VoiceCallProcessor"]

  %% ─── Scheduler ───
  SchedulerService["SchedulerService"]
  TaskProcessor["TaskProcessor"]
  ScheduledMessageProcessor["ScheduledMessageProcessor"]

  %% ─── Garden agents ───
  GardenSeederProcessor["GardenSeederProcessor"]
  GardenTenderProcessor["GardenTenderProcessor"]

  %% ─── Vault & sync ───
  VaultService["VaultService"]
  Filesystem[("Filesystem")]
  IndexSyncProcessor["IndexSyncProcessor"]
  Qdrant[("Qdrant")]

  %% ─── Message processing pipeline ───
  Telegram --> TelegramUpdate --> InboundService
  InboundService -- "inbound-messages" --> InboundProcessor --> ChannelOrchestrator
  ChannelOrchestrator --> Anthropic
  ChannelOrchestrator -. "message.broadcast" .-> BroadcastHandler --> Telegram
  InboundService -. "inbound:abort" .-> InboundProcessor

  %% ─── Voice path ───
  Twilio -- "WebSocket" --> VoiceGateway --> ChannelOrchestrator
  Twilio -- "HTTP" --> VoiceTwimlController
  VoiceCallProcessor -- "voice-calls" --> Twilio

  %% ─── Scheduler ───
  SchedulerService -- "scheduled-tasks" --> TaskProcessor
  TaskProcessor -- "scheduled-messages" --> ScheduledMessageProcessor --> ChannelOrchestrator
  TaskProcessor -- "voice-calls" --> VoiceCallProcessor

  %% ─── Garden agents ───
  GardenSeederProcessor --> ChannelOrchestrator
  GardenTenderProcessor --> VaultService

  %% ─── Vault & sync ───
  VaultService --> Filesystem
  VaultService -. "VaultEvents" .-> IndexSyncProcessor --> Qdrant

  %% ─── Styles ───
  classDef external fill:#f4e6ff,stroke:#9b59b6,color:#000
  classDef store fill:#e8f4fd,stroke:#2980b9,color:#000
  classDef internal fill:#eafaf1,stroke:#27ae60,color:#000

  class Telegram,Twilio,Anthropic external
  class Filesystem,Qdrant store
  class TelegramUpdate,InboundService,InboundProcessor,ChannelOrchestrator,BroadcastHandler,VoiceGateway,VoiceTwimlController,VoiceCallProcessor,SchedulerService,TaskProcessor,ScheduledMessageProcessor,GardenSeederProcessor,GardenTenderProcessor,VaultService,IndexSyncProcessor internal
```

### Legend

| Line Style | Meaning |
|---|---|
| **Solid with label** (`── "queue" ──`) | BullMQ queue (routed through AgentDispatcher) |
| **Dashed** (`╌╌`) | EventEmitter or Redis Pub/Sub |
| **Solid, no label** | Direct function call |

### Communication Details

**BullMQ Queues** — All queues use Redis and are registered with `AgentDispatcher` (central routing hub) unless noted.

| Queue | Producer | Consumer |
|---|---|---|
| `inbound-messages` | InboundService | InboundProcessor |
| `scheduled-tasks` | SchedulerService | TaskProcessor |
| `scheduled-messages` | TaskProcessor | ScheduledMessageProcessor |
| `voice-calls` | TaskProcessor / VoiceCallFactory tool | VoiceCallProcessor |
| `garden-seeder` | SeedToolFactory tool | GardenSeederProcessor |
| `index-sync` | VaultEvents (self-managed) | IndexSyncProcessor |
| `garden-tending` | Cron / manual trigger (self-managed) | GardenTenderProcessor |

**Events & Pub/Sub**

| Channel | Type | Purpose |
|---|---|---|
| `message.broadcast` | EventEmitter | Delivers outbound messages to BroadcastHandler |
| `VaultEvents` (created/changed/deleted) | EventEmitter | Triggers index sync to Qdrant |
| `inbound:abort` | Redis Pub/Sub | Cancels in-flight LLM calls on new message |

**External Integrations**

| Service | Used By | Purpose |
|---|---|---|
| Anthropic | LlmService | LLM inference (Claude) |
| OpenAI | IndexSyncProcessor | Embeddings for vector search |
| ElevenLabs | TranscriptionService | Audio transcription |
| Exa | ChannelOrchestrator (tool) | Web search |
| Twilio | VoiceCallProcessor, VoiceGateway | Outbound/inbound voice calls |
| Telegram | TelegramUpdate, BroadcastHandler | Chat transport |

**Data Stores**

| Store | Purpose |
|---|---|
| Redis | BullMQ queues, Pub/Sub, conversation history, scheduler state |
| Qdrant | Vector index for semantic search over vault notes |
| Filesystem | Markdown vault (plain `.md` files, watched via `fs.watch`) |

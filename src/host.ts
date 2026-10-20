/**
 * Narrow local contracts for the DSH host services and events this plugin
 * consumes. Keeping these structural copies (instead of importing host source
 * packages) lets the package build self-contained; a composed DSH profile
 * supplies the real implementations at runtime. Field shapes mirror
 * `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-session`,
 * `@deepseek-ai/dsh-user-approval`, and `@deepseek-ai/dsh-storage-domain` as of
 * dsh 0.1.7-alpha.2.
 *
 * Each interface is a SUBSET of the host's own type: a field this plugin never
 * reads is left out rather than mirrored, which keeps a host addition from
 * forcing an edit here. A field the plugin does read is mirrored exactly.
 * @module @nextnowlabs/dsh-lark/host
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The live session a host agent drives; only the identity is read here.
 *
 * There is deliberately no `events` member: dsh 0.1.7 dropped the session's
 * raw event array (`snapshotEvents()` is the deprecated stand-in), and every
 * state this plugin used to fold from it now comes from the service that owns
 * it — plan mode from {@link HostPlanModeRead.get}, not from the log.
 */
export interface HostSession {
  /** The session id shared by the agent registry and session log. */
  readonly id: string
}

/** Durable metadata for one stored image, from {@link HostAttachments.saveImage}. */
export interface HostImageRef {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/** One model-facing content block this plugin produces. */
export type HostContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: HostImageRef }

/** A user-role message accepted by {@link HostAgent.followup}. */
export interface HostUserMessage {
  /** Stable message identity; a fresh UUID per message. */
  readonly id: string
  readonly role: 'user'
  /** Model-facing content blocks: the chat's text, plus any images it carried. */
  readonly content: readonly HostContentBlock[]
  /** Producer tag: chat input is a direct human prompt. */
  readonly source: { readonly kind: 'user' }
}

/** What one image must satisfy to be stored, from the attachment service. */
export interface HostImageLimits {
  readonly maxImageBytes: number
  readonly maxImagesPerMessage: number
  readonly maxMessageImageBytes: number
  readonly mediaTypes: readonly string[]
}

/**
 * The `attachments` store (subset of the host `AttachmentStore`). Images reach
 * a model as an opaque reference to bytes this service owns, never as a path
 * or a URL, so a chat image has to be committed here before it can be sent.
 */
export interface HostAttachments {
  readonly imageLimits: HostImageLimits
  /** Validate and durably commit one image; the media type is checked against the bytes. */
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<HostImageRef>
}

/** One pickable preset, as the process-level catalog describes it. */
export interface HostPresetOption {
  /** The preset name a switch is addressed by. */
  readonly value: string
  readonly name?: string
  readonly description?: string
}

/**
 * The deployment's permission presets (subset of the host `permissionPresets`
 * service). Read-only here: this channel classifies a switch by what the
 * preset actually does, and leaves the writing to `/permission`.
 */
export interface HostPermissionPresets {
  /** Every switchable preset name, in the table's declaration order. */
  readonly names: readonly string[]
  /**
   * One preset's knob bundle.
   * @throws when the name is not in the deployment's table.
   */
  resolve(name: string): {
    readonly sandbox: string
    readonly approval: string
    readonly name?: string | undefined
    readonly description?: string | undefined
  }
  /**
   * The whole table, with the labels a picker shows.
   *
   * This — not the session's `permissions` projection — is where the choices
   * live: since dsh 0.1.7 that projection carries only `currentValue`, so a
   * picker built from it offers nothing at all.
   */
  catalog(): { readonly options: readonly HostPresetOption[]; readonly defaultPreset?: string }
}

/**
 * One session as the host's corpus lists it (subset of `SessionRecord`).
 * `header.cwd` is what decides whether a conversation may continue it, and
 * `live` is what tells a chat the web UI is already driving it.
 */
export interface HostSessionRecord {
  readonly header?: {
    readonly id?: string
    readonly cwd?: string
    readonly createdAt?: number
    /**
     * `subagent` for work an agent delegated to itself. Those are not
     * conversations anyone had: they open with an instruction the agent wrote,
     * run one turn, and end.
     */
    readonly origin?: string
    /** Depth below a driving session; anything above zero was delegated. */
    readonly delegationDepth?: number
    /** The session this one was forked from, when it was forked at all. */
    readonly parentSession?: string
  }
  /** Whether an agent currently drives this id. */
  readonly live?: boolean
  /**
   * Whether any medium still holds this session. The host lists a few ids it
   * knows only from memory, and continuing one of those cannot work.
   */
  readonly persisted?: boolean
}

/** One event of a session, as the query engine's lightweight listing gives it. */
export interface HostEventRecord {
  readonly seq: number
  readonly type: string
  /** Unix epoch milliseconds. */
  readonly time: number
}

/**
 * One raw event as the log holds it. `source` is the field this channel is
 * after: a session's `user/message` stream carries injected context — system
 * prompt snapshots, skill catalogs, job notices — beside what a person typed,
 * and only the source tells them apart.
 */
export interface HostRawEvent {
  readonly seq: number
  readonly type: string
  readonly time?: number
  readonly data?: {
    readonly source?: { readonly kind?: string }
    readonly content?: readonly { readonly type?: string; readonly text?: string }[]
  }
}

/** One result of a batch title read; a rejected one carries no value. */
export type HostTitleResult =
  | { readonly sessionId: string; readonly status: 'fulfilled'; readonly value?: { readonly title?: { readonly title?: string } } }
  | { readonly sessionId: string; readonly status: 'rejected'; readonly reason?: unknown }

/**
 * The `sessionQuery` engine (subset). Read-only: this channel lists what a
 * conversation may continue and folds titles to label them, and leaves every
 * write to the session store.
 */
export interface HostSessionQuery {
  /** The complete logical corpus, newest first. */
  listSessions(signal?: AbortSignal): Promise<readonly HostSessionRecord[]>
  /**
   * Lightweight records for one session's events — no text, so counting what a
   * conversation contains and asking when it last moved costs no payload.
   */
  listEvents?(sessionId: string): Promise<readonly HostEventRecord[]>
  /**
   * One full event plus a bounded window around it — the only read here that
   * carries an event's `source`, which is what tells a person's message apart
   * from the ones a plugin injected into the same stream.
   */
  readEvent?(request: {
    readonly sessionId: string
    readonly seq: number
    readonly before?: number
    readonly after?: number
  }): Promise<{ readonly events?: readonly HostRawEvent[] }>
  /**
   * Fold the latest title for several sessions at once. Optional because a
   * deployment may compose a query engine without it; the picker then labels
   * rows by time alone.
   */
  readTitleSnapshots?(sessionIds: readonly string[], signal?: AbortSignal): Promise<readonly HostTitleResult[]>
}

/** Public live-agent handle (subset of the host `Agent` interface). */
export interface HostAgent {
  /** The single identity shared with {@link session}. */
  readonly id: string
  readonly session: HostSession
  /** Queue an ordinary follow-up turn and wake the driver. */
  followup(message: HostUserMessage): void
  /**
   * Clear queued work and abort the active turn. A no-op when nothing is
   * active, so a chat may offer it unconditionally.
   *
   * The cause is a DISCRIMINATED OBJECT, not a label: dsh 0.1.7 narrows the
   * reason into the durable `turn/end` record, and a bare string reaches the
   * loop's exhaustive switch as an unrecognized variant and throws there —
   * which loses the turn's own ending rather than merely mislabelling it.
   */
  cancel(cause: HostAgentCancelCause, options?: { readonly keepInbox?: boolean }): void
  /**
   * Resolve once the agent has no driver or maintenance task running.
   * Optional here because the contract reaches this plugin as an object rather
   * than as a dependency range: an older host simply has no such method.
   */
  whenIdle?(): Promise<void>
  /**
   * Run one non-turn task from the agent's true idle phase. The task starts
   * synchronously once that phase is claimed, later waking input waits in the
   * inbox until it settles, and the claim THROWS SYNCHRONOUSLY when a turn or
   * another maintenance task already owns the agent.
   *
   * This is what makes a channel-issued command safe: every command appends to
   * the session log, and the log takes one writer.
   */
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/**
 * Why a turn was cancelled, as the host's own closed union. A `hook` cause
 * carries the reason the hook named; the rest are one-shot labels.
 */
export type HostAgentCancelCause =
  | { readonly kind: 'user' }
  | { readonly kind: 'parent' }
  | { readonly kind: 'hook'; readonly reason: string }
  | { readonly kind: 'disposed' }

/** An owned agent plus its teardown capability, from `agents.create()`. */
export interface HostAgentHandle {
  readonly agent: HostAgent
  dispose(): Promise<void>
}

/** Per-agent provider/model routing accepted by {@link HostAgentRegistry.create}. */
export interface HostAgentOptions {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/** One persisted session's header, as this plugin's lookup reads it. */
export interface HostSessionHeader {
  readonly id: string
  /** Unix epoch milliseconds; the newest header for a chat is the one to resume. */
  readonly createdAt: number
}

/** One snapshot the persistence provider lists (subset of `SessionPersistenceSnapshot`). */
export interface HostSessionSnapshot {
  readonly header: HostSessionHeader
}

/**
 * The `sessionPersistence` store (subset of the host provider). Only headers
 * are read: enough to find a chat's previous session without loading any log.
 * Since dsh 0.1.7 the listing takes an options object and answers with one
 * snapshot per session, the header one level down.
 */
export interface HostSessionPersistence {
  list(options?: { readonly signal?: AbortSignal }): Promise<readonly HostSessionSnapshot[]>
}

/** The `agents` registry service (subset of the host `AgentRegistry`). */
export interface HostAgentRegistry {
  /** Reopen a persisted session as a live agent, replaying its history. */
  resume(options: {
    readonly resumeSessionId: string
    readonly agentOptions?: HostAgentOptions
    readonly setup?: HostAgentSetup
  }): Promise<HostAgentHandle>
  create(options: {
    readonly sessionId: string
    readonly meta?: { readonly cwd?: string; readonly agentPreset?: string }
    readonly agentOptions?: HostAgentOptions
    /**
     * Creation-time composition of the agent's scoped world, awaited before
     * the session and agent are published. A rejection rolls the whole
     * creation back, so a broken composition never yields a half-built session.
     */
    readonly setup?: HostAgentSetup
  }): Promise<HostAgentHandle>
}

/**
 * Compose one unpublished agent's scoped world, its session and agent not yet
 * published.
 *
 * The agent is handed in as well as its context, and that is what makes a
 * per-agent view readable from a composition that resolved BEFORE any agent
 * existed: the callback runs once per agent, at the one moment the two are
 * both in hand.
 * @param agentCtx - the unpublished agent's scope.
 * @param agent - the unpublished agent itself.
 */
export type HostAgentSetup = (agentCtx: Context, agent: HostAgent) => Promise<void>

/**
 * The `tools` registry, as this plugin's per-agent composition uses it
 * (subset of the host `ToolRegistry`).
 */
export interface HostTools {
  /**
   * Register a monotonic execution guard. Registered through an agent's scoped
   * context it applies to that agent alone; returning a string denies the call
   * with that reason, and no other guard can force-allow what one denied.
   */
  guard(guard: (execution: { readonly name: string }) => string | undefined): () => void
  /**
   * Register a tool definition, returning its disposer. Through an agent's
   * scoped context the registration is that agent's alone, and a name already
   * present in an outer layer is SHADOWED rather than rejected — the registry
   * reserves exactly one name from shadowing (`run_code`), which makes
   * overriding any other an intended capability rather than a trick.
   *
   * Since dsh 0.1.7 a definition must also declare `output`
   * (`{ schema, render, presentationMeta? }`); the registry enforces it at
   * registration. This contract leaves the definition opaque, so each of this
   * plugin's own tools states its `output` at its own declaration site.
   *
   * Optional in this narrow contract so a deployment composing a registry
   * without it still boots; questions then fall back to being denied.
   */
  register?(definition: object): () => void
  /**
   * One visible tool definition in a viewing scope. The scope is an opaque
   * `ScopeKey`, and the one the host's own presenters pass is THE AGENT: the
   * agent's scope is parented to its preset's standing scope, so reading
   * through the agent sees strictly more than reading through the roster's
   * standing key alone. Omitted views the global layer, which a deployment
   * with a preset roster leaves empty.
   */
  get(name: string, scope?: unknown): HostToolDefinition | undefined
}

/** The presentation half of a tool definition (subset of the host `ToolDefinition`). */
export interface HostToolDefinition {
  /**
   * Pure projection of one pending call for a UI. Every variant of the host's
   * tool-call view carries a `title`; `kind` exists only on its generic
   * variant, so a terminal or diff view simply states no icon.
   */
  presentCall?(args: unknown): { readonly title?: string; readonly kind?: string } | undefined
}

/** One command this deployment offers, from {@link HostCommands.list}. */
export interface HostCommandDescriptor {
  /** Lowercase name without the leading slash. */
  readonly name: string
  /** Human-readable summary used in discovery surfaces. */
  readonly description: string
}

/** One settled command execution (subset of the host `CommandExecution`). */
export interface HostCommandExecution {
  /** The host also stamps a `commandId`; nothing here reads it. */
  readonly result:
    | { readonly kind: 'success'; readonly text?: string }
    | { readonly kind: 'error'; readonly text: string }
}

/**
 * The `commands` runtime: slash commands dispatched WITHOUT a model turn, which
 * is why a chat must route them here instead of letting the model read a literal
 * `/clear` as prose.
 */
export interface HostCommands {
  /** Commands available to one agent, for discovery. */
  readonly list: (agent: HostAgent) => readonly HostCommandDescriptor[]
  /**
   * Run one complete slash-command line. Resolves `undefined` when the syntax
   * or the name does not resolve, which is what distinguishes an unknown
   * command from one that ran and failed.
   *
   * `submittedAttachments` is the wire uploads accompanying the line; a chat
   * command carries none — a file sent to the chat lands in the workspace and
   * reaches the model as a path — so this passes an empty list every time.
   * The parameter is NOT optional: since dsh 0.1.7 it sits between the line
   * and the signal, and a three-argument call hands the signal to the wrong
   * parameter and leaves the real one undefined.
   */
  readonly execute: (
    agent: HostAgent,
    line: string,
    submittedAttachments: readonly unknown[],
    signal: AbortSignal,
  ) => Promise<HostCommandExecution | undefined>
}

/** The `systemPrompt` assembler, as this plugin's per-agent composition uses it. */
export interface HostSystemPrompt {
  /**
   * Register one ordered prompt section in the calling context's scope layer.
   * A scoped section SHADOWS a global one of the same name; only two sections
   * within one layer collide. This plugin registers agent-scoped only, so it
   * neither collides with nor hides a deployment's own sections.
   */
  section(section: { name: string; order: number; text: string }): () => void
}

/** One declared preset's metadata (subset of the host `AgentPreset`). */
export interface HostAgentPreset {
  readonly id: string
  /** Display name, when the declaration set one. */
  readonly name?: string
  /** One-line description, when the declaration set one. */
  readonly description?: string
  /** Sort key among the roster, when the declaration set one. */
  readonly order?: number
  /**
   * Why the preset could not be composed, when it could not. Resolving one
   * succeeds either way, so a caller that only reads {@link id} learns of the
   * failure later than it could — and as an opaque refusal from `mount`.
   */
  readonly broken?: string
}

/**
 * The `agentPresets` roster (subset of the host `AgentPresets`). A deployment
 * that composes one keeps every model-facing row — tools, prompt sections — on
 * the agent plane, so the tool registry's global layer is EMPTY and an agent
 * that joins no preset reaches the model with no tools at all.
 */
export interface HostAgentPresets {
  /**
   * Every declared preset, including ones that failed to compose.
   *
   * Optional in this narrow contract so a deployment composing an older
   * registry still boots untouched; `/agent` then has nothing to offer and
   * says so, rather than failing to load.
   * @returns the roster in its declared order.
   */
  list?(): Promise<readonly HostAgentPreset[]>
  /**
   * Resolve a preset id, or the roster default when absent. Metadata only:
   * since dsh 0.1.7 a preset that failed to compose still resolves, carrying
   * its failure in {@link HostAgentPreset.broken}, and `mount` is what refuses.
   * @throws when the roster supplies no such preset.
   */
  resolve(id?: string): Promise<HostAgentPreset>
  /**
   * Join one agent's scope to a preset's standing composition. Call from the
   * agent factory's `setup(agentCtx)`.
   */
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

/** One workspace record (subset of the host `Workspace` entity). */
export interface HostWorkspace {
  readonly id: string
  /** The record's canonical (realpath) directory. */
  readonly path: string
  /**
   * Account one session under this workspace. Validates the session header's
   * cwd against {@link path}, so a session created with that exact value
   * attaches and one created with an uncanonicalized variant is rejected.
   */
  attachSession(id: string): Promise<unknown>
}

/**
 * The `workspaceRegistry` service (subset of the host registry). Grouping is
 * accounted, not derived: a session whose cwd merely matches a workspace stays
 * Ungrouped until something attaches it.
 */
export interface HostWorkspaceRegistry {
  /** The record for a canonical path, or undefined when none is registered. */
  resolveByPath(path: string): Promise<HostWorkspace | undefined>
  /** Register a workspace for a directory; at most one record exists per canonical path. */
  create(path: string, title?: string): Promise<HostWorkspace>
  /**
   * Every registered workspace. Optional in this narrow contract so a
   * deployment composing an older registry still boots; `/ws` then lists only
   * what this channel itself has seen.
   */
  list?(): readonly HostWorkspace[]
  /**
   * Sessions the operator archived: the host's own "hide this from every
   * grouping surface". Optional for the same reason as {@link list}.
   */
  readonly archivedSessionIds?: readonly string[]
}

/** One provider route, as the `llm` registry advertises it. */
export interface HostLlmProvider {
  readonly id: string
  readonly name: string
}

/** One advertised model on a provider route. */
export interface HostLlmModel {
  readonly provider: string
  readonly id: string
  readonly name: string
}

/**
 * The `llm` adapter registry (subset of the host `LlmRuntime`). Listing is
 * advisory by the host's own contract — adapters may accept model ids they do
 * not advertise — so a consumer must never turn absence into rejection.
 */
export interface HostLlm {
  listProviders(): HostLlmProvider[]
  listModels(provider: string): Promise<readonly HostLlmModel[]>
}

/** The `agentDefaultModel` service (subset of `AgentDefaultModelConfig`). */
export interface HostDefaultModel {
  /** The deployment's current default provider/model selection. */
  currentSelection(): HostAgentOptions
}

/** The Cordis loader service; awaited so agents never see a half-composed tree. */
export interface HostLoader {
  await(): Promise<unknown>
}

/**
 * One record table of an opened domain (subset of the host `KvTable`). Reads
 * are synchronous out of the domain's authoritative memory; every write
 * resolves only after the medium holds it, so `true` from a write here means
 * the value survives a restart.
 */
export interface HostDomainTable {
  get(key: string): unknown
  keys(): IterableIterator<string>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
}

/** One opened state domain (subset of the host `Domain`). */
export interface HostStateDomain {
  /** The global singleton slot; its spec's `initial` until the first write. */
  readonly global: {
    get(): unknown
    set(value: unknown): Promise<void>
  }
  table(name: string): HostDomainTable
  /**
   * Release the domain and its backend unit. The consumer owns this call —
   * register it as an effect disposer — and a closed domain rejects further
   * writes rather than silently dropping them.
   */
  close(): Promise<void>
}

/**
 * The `storageDomain` data form (subset of the host `DomainFacility`).
 *
 * This is where dsh 0.1.7 keeps durable, non-session plugin state. It replaces
 * the settings-provider seam this plugin used to write per-conversation state
 * through: `ctx.settings` is now a form surface over the profile row's own
 * `config`, and a row's config belongs to whoever edits the profile patch, not
 * to the bot writing a `/cd` switch into it.
 *
 * The spec passed to {@link open} is declared by this plugin; a backend that
 * cannot serve the routed domain refuses the open, which is why every caller
 * here treats a failed open as "state is memory-only" rather than as fatal.
 *
 * Read through a cast rather than declared on `Context`: this is an OPTIONAL
 * seam — a deployment may compose no storage at all — and a declaration here
 * would merge with the host package's own, which requires it.
 */
export interface HostStorageDomain {
  open(spec: object): Promise<HostStateDomain>
}

/**
 * The `sessionProjections` registry, narrowed to reading one session's cut.
 *
 * Every projection the deployment composed folds the same session log: token
 * usage, context occupancy, step counts. Reading is synchronous and consistent
 * — one snapshot answers for one log position — so a status report never
 * mixes two.
 */
export interface HostSessionProjections {
  /**
   * Read every registered projection for one session.
   * @param session - the session to read.
   * @returns the cut, keyed by projection, and the log position it answers for.
   */
  snapshot(session: HostSession): { readonly asOfSeq: number; readonly values: Record<string, unknown> }
}

/** Whole-session token totals, as the host's `tokenUsage` projection reports them. */
export interface HostTokenUsage {
  readonly uncachedInputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

/**
 * How full the model's context is, as the host's `contextPressure` projection
 * reports it. Every field is optional: a session that has not yet made a
 * request has no sample, and a provider that reports no window has no
 * denominator.
 */
export interface HostContextPressure {
  /** Prompt-side tokens the last request actually carried. */
  readonly pressureTokens?: number
  /** What the NEXT request would carry, moved by everything logged since. */
  readonly projectedTokens?: number
  readonly contextWindow?: number
}

/** One immutable entry in the host session log; narrowed via the guards below. */
export interface HostSessionEvent {
  readonly type: string
  readonly data: unknown
}

/** The `assistant/message` payload fields this plugin renders. */
export interface AssistantMessageData {
  readonly turn: number
  readonly message: {
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
}

/** The `turn/end` payload fields this plugin reports. */
export interface TurnEndData {
  readonly turn: number
  /**
   * How the turn closed. The host's own union also carries `aborted`,
   * `blocked`, `max-tokens`, `interrupted`, and `forked`; only `error` names a
   * failure, and every other kind closes the turn as an ordinary ending.
   */
  readonly reason: {
    readonly kind: string
    readonly error?: { readonly code?: string; readonly message?: string }
  }
}

/** The `step/start` payload fields this plugin uses to warm a card up. */
export interface StepStartData {
  readonly turn: number
  readonly step: number
}

/** The `turn/start` payload fields this plugin uses. */
export interface TurnStartData {
  readonly turn: number
}

/**
 * The `user/message` payload: the message object a turn consumed, carrying the
 * id its producer stamped on it. One turn may consume SEVERAL queued messages,
 * so this event — not turn order — is what correlates a turn with the inbound
 * message(s) it answers.
 */
export interface UserMessageEventData {
  readonly id?: string
}

/** The `assistant/chunk` payload fields this plugin streams. */
export interface AssistantChunkData {
  readonly turn: number
  /**
   * One raw stream chunk. Only `text-delta` reaches the chat: `reasoning-delta`
   * is the model's private thinking and stays off the wire, and tool-call
   * deltas are raw JSON fragments reported through `tool/call` instead.
   */
  readonly chunk: { readonly type: string; readonly text?: string }
}

/**
 * One live assistant-stream publication (subset of the host
 * `AssistantStreamFrame` union). A `chunk` frame names its ATTEMPT rather than
 * its turn, so a reader pairs it with the `start` frame carrying the same
 * `attemptId` — which is why {@link assistantStreamChunk} is fed the turn the
 * caller remembered.
 */
export type HostAssistantStreamFrame =
  | {
      readonly type: 'start'
      readonly attemptId: string
      readonly revision: number
      readonly turn: number
      readonly step: number
    }
  | {
      readonly type: 'chunk'
      readonly attemptId: string
      readonly revision: number
      /** Dense zero-based position within the attempt. */
      readonly index: number
      /** Safe-integer timestamp, reused by the durable embedded stream. */
      readonly time: number
      readonly chunk: { readonly type: string; readonly text?: string }
    }
  | { readonly type: 'end'; readonly attemptId: string; readonly revision: number; readonly index: number }

/** The `tool/result` payload fields a thinking process reports. */
export interface ToolResultData {
  readonly turn: number
  /**
   * The completed result message. Its content blocks are FLAT: the released
   * shape this plugin used to read nested a `tool-result` wrapper carrying the
   * text, and session format v4 refuses that wrapper outright, so reading it
   * now yields an empty body for every call. The call id sits on the message
   * and on its source, not on a block.
   */
  readonly message: {
    /** The producing call, so a result pairs with the call that asked. */
    readonly source?: { readonly kind?: string; readonly callId?: string }
    readonly toolCallId?: string
    /** Model-facing blocks; a tool's text output is a top-level `text` block. */
    readonly content: readonly { readonly type: string; readonly text?: string }[]
  }
  readonly error?: { readonly name: string; readonly code: string }
}

/** The `tool/call` payload fields this plugin surfaces as activity. */
export interface ToolCallData {
  readonly turn: number
  /** Pairs the call with the approval question that decides it. */
  readonly callId: string
  readonly name: string
  /** Raw arguments JSON exactly as the model produced it (unparsed, untrusted). */
  readonly arguments: string
}

/**
 * Narrow a session event to the assembled assistant message for one step.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link AssistantMessageData}.
 */
export function isAssistantMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantMessageData } {
  return event.type === 'assistant/message'
}

/**
 * Narrow a session event to a closed turn boundary.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link TurnEndData}.
 */
export function isTurnEndEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnEndData } {
  return event.type === 'turn/end'
}

/**
 * Narrow a session event to the opening of one step.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link StepStartData}.
 */
export function isStepStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: StepStartData } {
  return event.type === 'step/start'
}

/**
 * Narrow a session event to the opening of one turn.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link TurnStartData}.
 */
export function isTurnStartEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: TurnStartData } {
  return event.type === 'turn/start'
}

/**
 * Narrow a session event to a user message a turn consumed.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link UserMessageEventData}.
 */
export function isUserMessageEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: UserMessageEventData } {
  return event.type === 'user/message'
}

/**
 * Narrow a session event to one raw assistant stream chunk.
 *
 * The record is this plugin's own: dsh 0.1.7 no longer publishes an
 * `assistant/chunk` SESSION event, and this bridge normalizes the live
 * `agent/assistant-stream` frames onto the same shape (
 * {@link assistantStreamChunk}) so both renderers keep reading one contract.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link AssistantChunkData}.
 */
export function isAssistantChunkEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: AssistantChunkData } {
  return event.type === 'assistant/chunk'
}

/**
 * Narrow a session event to one completed tool call's result.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link ToolResultData}.
 */
export function isToolResultEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolResultData } {
  return event.type === 'tool/result'
}

/**
 * The call one result answers, and the text it produced.
 * @param data - the completed result payload.
 * @returns the call id and its joined text output.
 */
export function toolResultText(data: ToolResultData): { callId: string | undefined; text: string } {
  const text = data.message.content
    .filter(block => block.type === 'text' && block.text !== undefined)
    .map(block => block.text)
    .join('')
  return { callId: data.message.toolCallId ?? data.message.source?.callId, text }
}

/**
 * Normalize one live stream frame into the record this plugin's renderers
 * consume — the shape the host published as an `assistant/chunk` SESSION event
 * until dsh 0.1.7 removed it.
 *
 * The frame carries no turn of its own, so the caller supplies the one it
 * remembered for this attempt. That pairing is the whole reason this lives
 * here rather than at each renderer: two renderers must not disagree about
 * which turn a delta belongs to.
 * @param frame - one live frame, as the host published it.
 * @param turn - the turn the frame's attempt was started for.
 * @returns the normalized chunk record, or undefined for a non-chunk frame.
 */
export function assistantStreamChunk(frame: HostAssistantStreamFrame, turn: number): HostSessionEvent | undefined {
  if (frame.type !== 'chunk') return undefined
  return { type: 'assistant/chunk', data: { turn, chunk: frame.chunk } satisfies AssistantChunkData }
}

/**
 * Narrow a session event to one model-requested tool invocation.
 * @param event - any session event.
 * @returns whether `event.data` carries {@link ToolCallData}.
 */
export function isToolCallEvent(
  event: HostSessionEvent,
): event is HostSessionEvent & { readonly data: ToolCallData } {
  return event.type === 'tool/call'
}

/**
 * Join the text blocks of a committed assistant message.
 * @param data - the committed message payload.
 * @returns the concatenated text, empty when the step produced none.
 */
export function assistantText(data: AssistantMessageData): string {
  return data.message.content
    .filter(block => block.type === 'text' && block.text !== undefined && block.text !== '')
    .map(block => block.text)
    .join('')
}

/**
 * Render a failed turn's reason as one operator-readable line.
 * @param data - the closed turn payload.
 * @returns the error detail, empty when the turn did not fail.
 */
export function turnErrorDetail(data: TurnEndData): string {
  if (data.reason.kind !== 'error') return ''
  const error = data.reason.error
  return error === undefined ? '' : `${error.code ?? 'error'}: ${error.message ?? ''}`.trimEnd()
}

/** Closed outcome of a host approval question; `'allowed-once'` is the only grant. */
export type HostApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

/** Readonly same-process permission question (subset of `ApprovalRequest`). */
export interface HostApprovalRequest {
  /** The agent on whose behalf the question is asked; routes the question. */
  readonly agent: HostAgent
  /** The tool the question is about (presentation and audit). */
  readonly toolName: string
  /** The exact tool call being decided, when the asker has one. */
  readonly callId?: string
  /** The asker's human-readable explanation of WHY it is asking. */
  readonly reason?: string
  /** Aborting withdraws the question; a late answer is discarded. */
  readonly signal?: AbortSignal
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host agent registry; required via `inject`. */
    agents: HostAgentRegistry
  }
  interface Events {
    /** Durable session facts broadcast by the host session store. */
    'session/event'(session: HostSession, event: HostSessionEvent): void
    /**
     * One message left an agent's inbox inside its open turn. This is where a
     * turn decides what it is answering, and it precedes the turn's first
     * step — which is why a reply is aimed here rather than at the later
     * `user/message` record.
     */
    'agent/inbox/claimed'(payload: {
      readonly agent: HostAgent
      readonly message: { readonly id?: string }
      readonly turn: number
    }): void
    /**
     * One live assistant-stream publication, process-local and transient: the
     * host appends a matching `assistant/message` (or `assistant/attempt`)
     * carrying the whole stream before the closing frame. This is what a
     * typewriter card and a reasoning stream are built from now that the
     * `assistant/chunk` session event is gone.
     *
     * A `chunk` frame names an attempt, not a turn, so a reader pairs it with
     * the `start` frame of the same attempt.
     */
    'agent/assistant-stream'(payload: {
      readonly agent: HostAgent
      readonly frame: HostAssistantStreamFrame
    }): void
    /** Waterfall permission question; answer only for owned agents, else delegate via `next()`. */
    'approval/request'(
      request: HostApprovalRequest,
      next: () => Promise<HostApprovalOutcome>,
    ): Promise<HostApprovalOutcome>
  }
}

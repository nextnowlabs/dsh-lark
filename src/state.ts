/**
 * Where this channel keeps what it must not forget.
 *
 * Two kinds of durable fact live here, and neither is configuration:
 *
 * - what a conversation decided — the directory it was `/cd`-ed to, the model
 *   route it asked for, the Agent preset it starts new sessions under, how
 *   many times it started over, and the session it was explicitly pointed at;
 * - what first-boot onboarding learned — the app it created and, when a
 *   credentials provider could not take the secret, the secret itself.
 *
 * This used to go through the host's settings provider. dsh 0.1.7 removed that
 * seam: `ctx.settings` is now a form surface over the profile row's own
 * `config`, and the row's config belongs to whoever edits the profile patch.
 * A bot writing a `/cd` switch into that file would be rewriting its operator's
 * configuration — and every chat switch would bump the revision the settings
 * UI fences its own edits with. Durable plugin state has its own seam now:
 * `ctx.storageDomain`, a schema-validated key/value domain over whichever
 * backend the deployment routed it to.
 *
 * Two properties are load-bearing here, both inherited from the seam this
 * replaces:
 *
 * - **Optional.** A deployment that composes no storage domain keeps working
 *   with memory-only state; every writer answers `false` and the command that
 *   tried to persist says so in the chat. Losing a switch on restart beats
 *   refusing to switch.
 * - **Never fatal.** A domain that cannot be opened — no backend routed, a
 *   record the schema rejects — is reported once on the operator console and
 *   then treated exactly like no storage at all.
 * @module @nextnowlabs/dsh-lark/state
 */

import { z } from 'zod'
import type { HostStateDomain, HostStorageDomain } from './host.ts'

/**
 * The conversation-keyed maps this channel persists, under the names the
 * profile row's legacy config used. Kept identical so an upgraded deployment's
 * existing values are read back without a migration step.
 */
export interface ChannelState {
  /** The directory each conversation was `/cd`-ed to; `''` is "explicitly the default". */
  readonly chatWorkspaces: Record<string, string>
  /** The `provider/model` route each conversation asked for; `''` is "the deployment default". */
  readonly chatModels: Record<string, string>
  /** How many times each conversation started over, keyed by its epoch-zero session id. */
  readonly chatEpochs: Record<string, string>
  /** The session each conversation was pointed at; `''` is "derive it again". */
  readonly chatSessions: Record<string, string>
  /** The Agent preset each conversation asked for; `''` is "the deployment default". */
  readonly chatPresets: Record<string, string>
  /** The Lark app this deployment onboarded, when it did. */
  readonly appId?: string | undefined
  /** The credential holding that app's secret, when a provider took it. */
  readonly appSecretRef?: string | undefined
  /**
   * The app secret, kept here ONLY when no credentials provider was composed
   * to take it. A provider is the right home; this is the same fallback the
   * settings document used to be, kept because re-scanning a QR code on every
   * restart — and creating a second app on the platform — is worse.
   */
  readonly appSecret?: string | undefined
  /** The open id that scanned the QR code, when the platform reported one. */
  readonly registeredBy?: string | undefined
}

/**
 * The same shape without `readonly`, for the one place that writes it: the
 * store's own copy, which mirrors the domain record for record.
 */
type MutableState = { -readonly [K in keyof ChannelState]: ChannelState[K] }

/** One patch of channel state, keyed the way {@link ChannelState} names its fields. */
export type StatePatch = {
  [K in keyof ChannelState]?: ChannelState[K] extends Record<string, string>
    ? Record<string, string>
    : ChannelState[K]
}

/** Table names, one per conversation-keyed map. */
export const STATE_TABLES = {
  chatWorkspaces: 'chat_workspaces',
  chatModels: 'chat_models',
  chatEpochs: 'chat_epochs',
  chatSessions: 'chat_sessions',
  chatPresets: 'chat_presets',
} as const

/** One table of {@link STATE_TABLES}. */
export type StateTableName = (typeof STATE_TABLES)[keyof typeof STATE_TABLES]

/**
 * The global record's schema. Every field is optional and every field is a
 * string: this is onboarded fact, not configuration, and the domain validates
 * it at the durable boundary so a hand-edited file cannot hand the transport a
 * number where it expects an app id.
 */
const globalSchema = z.object({
  appId: z.string().optional(),
  appSecretRef: z.string().optional(),
  appSecret: z.string().optional(),
  registeredBy: z.string().optional(),
})

/** One conversation's stored value. Records are strings, exactly as the maps were. */
const recordSchema = z.string()

/**
 * The domain this plugin declares, as the spec `storageDomain.open()` takes.
 *
 * Declared here rather than imported from the host's `defineDomain` so the
 * package keeps building and booting with no host source dependency — the same
 * reason every other host contract in this package is a structural copy. The
 * shape is the host's `DomainSpec`, and `tests/state.spec.ts` opens this exact
 * literal through the host's own validator AND through its real storage hub,
 * json backend and domain form over a temporary directory: a host that
 * tightened either fails a test here rather than at a deployment's boot.
 *
 * `single` layout is not a preference: conversation keys carry `:` under the
 * `chat-thread` and `chat-sender` scopes, and a `per-record` backend turns
 * every key into a file name.
 * @param name - the domain (and backend unit) name, already shaped for it.
 * @returns the spec to hand `storageDomain.open()`.
 */
export function channelDomainSpec(name: string): object {
  const tables = Object.fromEntries(
    Object.values(STATE_TABLES).map(table => [table, { valueSchema: recordSchema }]),
  )
  return {
    name,
    version: 1,
    layout: 'single' as const,
    global: { schema: globalSchema, initial: {} },
    tables,
  }
}

/** What a caller gets back once a domain is open, or when none could be. */
export interface StateStore {
  /**
   * Everything stored, read synchronously from the domain's own memory. Empty
   * for a store that never opened.
   */
  snapshot(): ChannelState
  /**
   * Merge one patch into the store and the medium.
   * @param patch - the fields to write; maps merge per key, scalars replace.
   * @returns whether the value is durable; `false` means memory-only.
   */
  apply(patch: StatePatch): Promise<boolean>
  /** Release the domain and its backend unit. Idempotent. */
  close(): Promise<void>
}

/** Read the scalar fields off an unknown global record, dropping blanks. */
function readScalars(raw: unknown): Pick<ChannelState, 'appId' | 'appSecretRef' | 'appSecret' | 'registeredBy'> {
  if (typeof raw !== 'object' || raw === null) return {}
  const source = raw as Record<string, unknown>
  const read = (key: string): string | undefined => {
    const value = source[key]
    return typeof value === 'string' && value !== '' ? value : undefined
  }
  const appId = read('appId')
  const appSecretRef = read('appSecretRef')
  const appSecret = read('appSecret')
  const registeredBy = read('registeredBy')
  return {
    ...appId === undefined ? {} : { appId },
    ...appSecretRef === undefined ? {} : { appSecretRef },
    ...appSecret === undefined ? {} : { appSecret },
    ...registeredBy === undefined ? {} : { registeredBy },
  }
}

/** Fold one table's records into a plain map. */
function readTable(domain: HostStateDomain, table: string): Record<string, string> {
  const records: Record<string, string> = {}
  try {
    const handle = domain.table(table)
    for (const key of handle.keys()) {
      const value = handle.get(key)
      if (typeof value === 'string') records[key] = value
    }
  } catch {
    // A table that cannot be read contributes nothing rather than taking the
    // whole snapshot down: a partially readable store still beats no store.
  }
  return records
}

/** Read the domain once, into the shape every caller here speaks. */
function readDomain(domain: HostStateDomain): ChannelState {
  let global: unknown
  try {
    global = domain.global.get()
  } catch {
    global = undefined
  }
  return {
    chatWorkspaces: readTable(domain, STATE_TABLES.chatWorkspaces),
    chatModels: readTable(domain, STATE_TABLES.chatModels),
    chatEpochs: readTable(domain, STATE_TABLES.chatEpochs),
    chatSessions: readTable(domain, STATE_TABLES.chatSessions),
    chatPresets: readTable(domain, STATE_TABLES.chatPresets),
    ...readScalars(global),
  }
}

/** One map entry a patch asks to persist, and the state field it belongs to. */
interface TableWrite {
  readonly field: MapField
  readonly table: StateTableName
  readonly key: string
  readonly value: string
}

/** What one patch asks to persist, split the way the domain stores it. */
interface FoldedPatch {
  readonly tables: readonly TableWrite[]
  /** The scalar fields, after the patch; `''` means "remove the field". */
  readonly scalars: Partial<Record<ScalarField, string>>
}

/** The map half of the state: one table each. */
type MapField = keyof typeof STATE_TABLES

/** The scalar half of the state: one global record, not a table. */
const SCALAR_FIELDS = ['appId', 'appSecretRef', 'appSecret', 'registeredBy'] as const
type ScalarField = (typeof SCALAR_FIELDS)[number]

/** Whether a patch value is one of the conversation-keyed maps. */
function isMapPatch(value: unknown): value is Record<string, string> {
  return typeof value === 'object' && value !== null
}

/**
 * Read one patch into what it asks to persist, without touching anything.
 *
 * Planning and applying are separate steps because the medium comes first: the
 * domain's own contract is that a rejected write leaves its memory untouched,
 * and a mirror that folded a patch before the write landed would disagree with
 * the medium it mirrors — reporting a `/cd` as durable on a backend that had
 * just refused it.
 * @param patch - the fields to merge.
 * @returns the table entries and scalar fields to write.
 */
function planPatch(patch: StatePatch): FoldedPatch {
  const tables: TableWrite[] = []
  const scalars: Partial<Record<ScalarField, string>> = {}
  for (const [field, value] of Object.entries(patch) as [keyof ChannelState, unknown][]) {
    const map = STATE_TABLES[field as MapField] as StateTableName | undefined
    if (map !== undefined) {
      if (!isMapPatch(value)) continue
      const named = field as MapField
      for (const [key, entry] of Object.entries(value)) tables.push({ field: named, table: map, key, value: entry })
      continue
    }
    if (typeof value === 'string') scalars[field as ScalarField] = value
  }
  return { tables, scalars }
}

/**
 * Fold one planned patch into a state value. Shared by both stores so a
 * deployment with storage and one without answer the same question the same way.
 * @param state - the state to update in place.
 * @param patch - the patch, as {@link planPatch} read it.
 */
function foldPatch(state: MutableState, patch: FoldedPatch): void {
  for (const write of patch.tables) state[write.field][write.key] = write.value
  for (const [field, value] of Object.entries(patch.scalars) as [ScalarField, string][]) {
    // An empty scalar is an ABSENT one everywhere in this channel — the
    // migration that moves a secret behind a credential blanks the field it
    // left behind — so it is dropped from the state rather than kept as ''.
    if (value === '') delete state[field]
    else state[field] = value
  }
}

/** The global record to store: the domain's current one, patched. */
function globalAfter(current: unknown, scalars: Partial<Record<ScalarField, string>>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(readScalars(current))) {
    if (typeof value === 'string') next[key] = value
  }
  for (const [field, value] of Object.entries(scalars)) {
    if (value === undefined || value === '') delete next[field]
    else next[field] = value
  }
  return next
}

/**
 * Open this channel's state domain, when the deployment composed one.
 *
 * A store that never opened is still a store: it answers the empty snapshot,
 * accepts writes it cannot keep, and reports them as memory-only. That is what
 * lets every caller here stay free of a "is there storage?" branch.
 * @param storage - the `storageDomain` service, when composed.
 * @param name - the domain name for this row; see `instanceIdentity`.
 * @param report - operator console line, used once per failure.
 * @returns the store to read and write through.
 */
export async function openStateStore(
  storage: HostStorageDomain | undefined,
  name: string,
  report: (line: string) => void,
): Promise<StateStore> {
  if (storage === undefined) return memoryOnlyStore()

  let domain: HostStateDomain
  try {
    domain = await storage.open(channelDomainSpec(name))
  } catch (error) {
    // Never fatal: a deployment whose storage backend is missing, routed
    // elsewhere, or holding a record this version cannot read still runs — it
    // just forgets. Said out loud, because "my /cd resets on restart" is
    // otherwise an unexplainable mystery rather than a stated limitation.
    report(`lark-channel: durable state is unavailable (${failureDetail(error)}); chat settings reset on restart`)
    return memoryOnlyStore()
  }

  // Reads come from a copy this store keeps in step with the domain, because
  // the domain's own memory is authoritative and every write below lands in
  // the medium before it is folded in — so the two cannot disagree.
  const state = readDomain(domain) as MutableState
  let closed = false
  return {
    snapshot: () => ({ ...state }),
    async apply(patch) {
      if (closed) return false
      const folded = planPatch(patch)
      for (const write of folded.tables) await domain.table(write.table).put(write.key, write.value)
      // The global is ONE record, so it is rewritten whole: a writer that sent
      // only its own field would drop every other. Read back rather than
      // merged locally, because the domain is what other writers wrote to.
      if (Object.keys(folded.scalars).length > 0) {
        await domain.global.set(globalAfter(domain.global.get(), folded.scalars))
      }
      foldPatch(state, folded)
      return true
    },
    async close() {
      if (closed) return
      closed = true
      await domain.close().catch(() => undefined)
    },
  }
}

/**
 * The store a deployment with no usable domain runs on: it remembers for this
 * process and says so by answering `false`.
 * @returns the memory-only store.
 */
function memoryOnlyStore(): StateStore {
  const state: MutableState = {
    chatWorkspaces: {},
    chatModels: {},
    chatEpochs: {},
    chatSessions: {},
    chatPresets: {},
  }
  return {
    snapshot: () => ({ ...state }),
    async apply(patch) {
      foldPatch(state, planPatch(patch))
      return false
    },
    close: () => Promise.resolve(),
  }
}

/**
 * One failure's message, for a console line.
 * @param error - whatever was thrown.
 * @returns the message, or its string form.
 */
function failureDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

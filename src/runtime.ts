/**
 * Runtime boundary and Cordis activation for the plugin.
 * @module @nextnowlabs/dsh-lark/runtime
 */

import { createLarkChannel, registerApp } from '@larksuite/channel'
import type { LarkChannelOptions, PolicyConfig } from '@larksuite/channel'
import type { Context } from '@deepseek-ai/cordis'
import { Config, resolveConfig } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { installBridge, type ChannelPort } from './bridge.ts'
import { migrateAppSecret, resolveAppSecret, storeAppSecret } from './credentials.ts'
import type { HostCredentials } from './credentials.ts'
import { instanceIdentity } from './instance.ts'
import type { CotEvent, CotHandle } from './cot.ts'
import type { PanelCommand } from './slash-panel.ts'
import { beginOnboarding } from './onboarding.ts'
import type { LarkCredentials, OnboardedApp, RegisterAppPort } from './onboarding.ts'
import { describeAuthorization, resolveAuthorization } from './authorization.ts'
import type { Authorization } from './authorization.ts'
import type { HostLoader, HostStorageDomain } from './host.ts'
import { openStateStore } from './state.ts'
import type { ChannelState, StatePatch, StateStore } from './state.ts'

/** Resolved configuration whose credentials are present; the transport can be built. */
export type ChannelConfig = ResolvedConfig & LarkCredentials

/** The app-config endpoint for the bot's slash-command panel; the SDK has no method for it. */
const SLASH_COMMAND_API = '/open-apis/application/v7/app_slash_commands'

/**
 * The thinking-process endpoint: `POST` opens one, `PUT` appends events, and a
 * terminal `RUN_FINISHED` closes it without a further call.
 */
const COT_API = '/open-apis/im/v1/message_cot'

/**
 * Narrow a resolved configuration to one carrying live credentials.
 * @param config - resolved plugin configuration.
 * @returns whether both credential fields are non-empty strings.
 */
function hasCredentials(config: ResolvedConfig): config is ChannelConfig {
  return typeof config.appId === 'string' && config.appId !== ''
    && typeof config.appSecret === 'string' && config.appSecret !== ''
}

/**
 * The transport options one deployment runs under.
 *
 * Separated from the client it configures so the decisions here — who the
 * transport itself will accept, and whether it may merge a chat's messages —
 * can be read and tested without a network client.
 * @param config - resolved plugin configuration with credentials.
 * @param authorization - who this deployment answers.
 * @returns the options for `createLarkChannel`.
 */
export function channelOptions(config: ChannelConfig, authorization: Authorization): LarkChannelOptions {
  // Transport-level defense in depth. The plugin's own inbound check is the
  // authority (it runs where the agent is driven), but leaving the transport at
  // its `dmMode: 'open'` default would let unauthorized traffic reach this
  // process at all — and an allowlist the transport enforces never depends on
  // this plugin's handler being reached.
  const policy: PolicyConfig = { requireMention: config.requireMention }
  // Only narrow when a deployment asked to. Who may open a conversation with
  // the bot at all is the app's visibility scope, set in the developer console;
  // restricting again here by default would duplicate that decision.
  if (authorization.directSenders.size > 0) {
    policy.dmMode = 'allowlist'
    policy.dmAllowlist = [...authorization.directSenders]
  }
  if (config.groupAllowlist.length > 0) policy.groupAllowlist = config.groupAllowlist
  const options: LarkChannelOptions = {
    appId: config.appId,
    appSecret: config.appSecret,
    policy,
    source: '@nextnowlabs/dsh-lark',
    respectProxyEnv: true,
  }
  // The transport batches by CHAT: messages arriving within its window are
  // merged into one, `{...last, content: joined}` — the LAST sender's name on
  // everyone's words. This channel prefixes each group message with who said
  // it, so a merge does not just blur a burst, it misattributes it: A's
  // sentence reaches the model labelled B. Under a finer session scope it is
  // worse still, handing one conversation another's words. Nothing is lost by
  // closing the window: the agent's own inbox already drains several queued
  // messages into a single turn.
  options.safety = { batch: { text: { delayMs: 0 }, media: { delayMs: 0 } } }
  if (config.domain !== undefined) options.domain = config.domain
  return options
}

/**
 * Create the production Lark transport from resolved configuration.
 * @param config - resolved plugin configuration with credentials.
 * @param authorization - who this deployment answers.
 * @returns the real `@larksuite/channel` client behind the bridge's port surface.
 */
export function createLarkChannelPort(config: ChannelConfig, authorization: Authorization): ChannelPort {
  const channel = createLarkChannel(channelOptions(config, authorization))
  // The slash-command panel has no SDK method; it is a plain app-config API,
  // reached through the transport's own authenticated client.
  const raw = channel.rawClient as {
    request(payload: { method: string; url: string; data?: unknown }): Promise<unknown>
  }
  return Object.assign(channel, {
    async listSlashCommands(): Promise<PanelCommand[]> {
      // The collection route requires a paging query; without one it 404s.
      const response = await raw.request({
        method: 'GET',
        url: `${SLASH_COMMAND_API}?page_size=50`,
      }) as { data?: { items?: { command?: string; command_id?: string }[] } }
      return (response.data?.items ?? [])
        .filter((item): item is { command: string; command_id: string } =>
          typeof item.command === 'string' && typeof item.command_id === 'string')
        .map(item => ({ command: item.command, commandId: item.command_id }))
    },
    async deleteSlashCommand(commandId: string): Promise<void> {
      await raw.request({ method: 'DELETE', url: `${SLASH_COMMAND_API}/${commandId}` })
    },
    async createCot(chatId: string, options: { replyTo?: string; hidden: boolean }): Promise<CotHandle> {
      const response = await raw.request({
        method: 'POST',
        url: `${COT_API}?receive_id_type=chat_id`,
        data: {
          receive_id: chatId,
          ...options.replyTo === undefined ? {} : { origin_message_id: options.replyTo },
          cot_hidden: options.hidden,
          // A thinking process is not news: it must not raise an unread badge
          // or pull the conversation to the top of the list on every turn.
          enable_badge: false,
          update_feed_rank: false,
        },
      }) as { data?: { cot_id?: string; message_id?: string } }
      const cotId = response.data?.cot_id
      const messageId = response.data?.message_id
      if (cotId === undefined || messageId === undefined) {
        throw new Error('lark-channel: the platform returned no cot_id/message_id')
      }
      return { cotId, messageId }
    },
    async writeCotEvents(handle: CotHandle, events: readonly CotEvent[]): Promise<void> {
      await raw.request({
        method: 'PUT',
        url: COT_API,
        data: { events, message_id: handle.messageId, cot_id: handle.cotId },
      })
    },
    async createSlashCommand(command: string, description: string): Promise<void> {
      await raw.request({
        method: 'POST',
        url: SLASH_COMMAND_API,
        data: { command, description: { default_value: description } },
      })
    },
  })
}

/** Substitutable production boundaries; tests replace them with fakes. */
export const internals: {
  createPort: (config: ChannelConfig, authorization: Authorization) => ChannelPort
  registerApp: RegisterAppPort
  /** Operator console line; the default profile composes no logger printer. */
  notify: (line: string) => void
  /** Shortest gap between two issued QR codes; absent keeps the onboarding default. */
  reissueFloorMs?: number
  /** Reconnect-watchdog deadline override; absent keeps the bridge default. */
  reconnectDeadlineMs?: number
  /** How an onboarded secret is stored; substituted in tests. */
  storeSecret: typeof storeAppSecret
} = {
  createPort: createLarkChannelPort,
  registerApp,
  storeSecret: storeAppSecret,
  // Stamped because the incident this console exists for was dated off a file
  // mtime: the log itself could not answer WHEN its last line was written.
  notify: (line) => void process.stderr.write(`[${new Date().toLocaleString('sv-SE')}] ${line}\n`),
}

/**
 * Apply the plugin to its Cordis context. With credentials configured (entry
 * config or a stored onboarding record) the transport connects directly;
 * without them the official QR registration flow runs first and persists what
 * it scanned through the host `credentials` seam and this channel's own
 * durable state domain, when one is composed.
 * @param ctx - Scoped plugin context; requires the `agents` service.
 * @param config - Configuration resolved by Cordis from the exported schema.
 */
export function apply(ctx: Context, config: Config): void {
  let active = true
  let started = false
  ctx.effect(() => () => { active = false }, 'lark:lifetime')

  /**
   * Install the bridge once credentials are known, stating this channel's reach
   * on the console: who it serves is a security fact its operator must see, and
   * a groups-only channel (no owner configured yet) is a valid deployment.
   */
  // Durable plugin state (onboarded credentials, workspace switches) goes
  // through this channel's own storage domain when the deployment composed
  // one; false tells the writer the value lives in memory only.
  let persistState = async (_patch: StatePatch): Promise<boolean> => false

  const start = (resolved: ChannelConfig): void => {
    if (!active || started) return
    started = true
    const authorization = resolveAuthorization(resolved)
    internals.notify(describeAuthorization(authorization))
    installBridge(
      ctx,
      resolved,
      internals.createPort(resolved, authorization),
      internals.notify,
      authorization,
      persistState,
      internals.reconnectDeadlineMs === undefined ? undefined : { deadlineMs: internals.reconnectDeadlineMs },
    )
  }

  const bootstrap = async (): Promise<void> => {
    // Loader siblings mount concurrently; whether the optional storage service
    // exists is only decided once the application settles.
    await (ctx.get('loader') as HostLoader | undefined)?.await()
    if (!active) return

    // A named row keys its state domain, its credential, and its session ids
    // apart from every other row; an unnamed one keeps the original
    // identifiers.
    const identity = instanceIdentity(config.instance)
    const store = await openStateStore(
      ctx.get('storageDomain') as HostStorageDomain | undefined,
      identity.stateDomain,
      internals.notify,
    )
    if (!active) {
      await store.close()
      return
    }
    ctx.effect(() => () => store.close(), 'lark:state')

    let persist = async (_app: OnboardedApp): Promise<boolean> => false
    const credentials = ctx.get('credentials') as HostCredentials | undefined
    let resolved = resolveConfig(seedFrom(config, store))
    persistState = async (patch) => {
      const durable = await store.apply(patch)
      // The store keeps the value either way, so what a later read of the
      // SAME process sees does not depend on the answer — only whether it
      // survives a restart does.
      return durable
    }
    // Onboarding hands the secret to the credentials seam and records only
    // the reference, so the durable store never learns it.
    persist = async (app) => {
      const stored = await internals.storeSecret(credentials, app.appSecret, internals.notify, identity.secretRef)
      return persistState({
        appId: app.appId,
        appSecret: stored.ref === undefined ? app.appSecret : '',
        ...stored.ref === undefined ? {} : { appSecretRef: stored.ref },
        ...app.registeredBy === undefined ? {} : { registeredBy: app.registeredBy },
      })
    }

    // A secret already sitting in the composition's config or in an imported
    // settings section moves behind a reference on this boot, so a bot
    // onboarded before the seam was used is repaired by restarting rather
    // than by scanning again.
    const migratedRef = await migrateAppSecret(credentials, resolved, persistState, internals.notify, identity.secretRef)
    if (migratedRef !== undefined) resolved = { ...resolved, appSecret: '', appSecretRef: migratedRef }

    const secret = await resolveAppSecret(credentials, resolved, internals.notify)
    if (secret !== undefined) resolved = { ...resolved, appSecret: secret }

    if (hasCredentials(resolved)) {
      start(resolved)
      return
    }
    const base = resolved
    beginOnboarding({
      ctx,
      register: internals.registerApp,
      notify: internals.notify,
      persist,
      onCredentials: app => { start({ ...base, ...app }) },
      appId: resolved.appId,
      ...identity.name === undefined ? {} : { instance: identity.name },
      ...internals.reissueFloorMs === undefined ? {} : { reissueFloorMs: internals.reissueFloorMs },
    })
  }

  void bootstrap().catch((error: unknown) => {
    ctx.logger.error('lark-channel bootstrap failed: %s', error instanceof Error ? error.message : error)
  })
}

/**
 * Fold what an upgraded deployment already had into the run's configuration.
 *
 * Two sources, in increasing precedence: the entry config, and the row's own
 * durable state. The first is how a deployment that stored these maps in the
 * removed settings document keeps them — the host imports that document's
 * sections into the profile row's `config`, so the values arrive as
 * configuration once and are read here as a SEED. The second is what this
 * channel has written since.
 *
 * Precedence is per KEY, not per map: a conversation `/cd`-ed after the
 * upgrade must not be dragged back to where the imported document left it by
 * some other conversation still living there.
 * @param config - the entry configuration, as the Loader resolved it.
 * @param store - this row's durable state.
 * @returns the configuration to resolve, with stored values folded in.
 */
function seedFrom(config: Config, store: StateStore): Config {
  const stored: ChannelState = store.snapshot()
  return {
    ...config,
    chatWorkspaces: { ...config.chatWorkspaces, ...stored.chatWorkspaces },
    chatModels: { ...config.chatModels, ...stored.chatModels },
    chatEpochs: { ...config.chatEpochs, ...stored.chatEpochs },
    chatSessions: { ...config.chatSessions, ...stored.chatSessions },
    chatPresets: { ...config.chatPresets, ...stored.chatPresets },
    ...stored.appId === undefined ? {} : { appId: stored.appId },
    ...stored.appSecretRef === undefined ? {} : { appSecretRef: stored.appSecretRef },
    // Only a deployment with no credentials provider ever stored the secret
    // itself, and its own record wins over a stale literal in the config.
    ...stored.appSecret === undefined ? {} : { appSecret: stored.appSecret },
  }
}

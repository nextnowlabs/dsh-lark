/**
 * Per-conversation Agent preset routing.
 *
 * A preset is not a route the way a model is. It decides which plugins an
 * agent is composed from — tools, prompt sections, skills — and the host
 * refuses to swap it once a session has started its first turn, because the
 * history was produced under that composition. What a conversation CAN choose
 * is which preset its NEXT session starts under. So a switch here records the
 * choice, retires the conversation's current binding, and derives a fresh
 * session; the old log stays on disk and `/sessions` can reach it again.
 *
 * The choices come from the deployment's `agentPresets` roster. The `preset`
 * config is only the DEFAULT for conversations that never picked one.
 *
 * The mapping persists through this channel's own durable store, beside the
 * workspace, model and epoch state.
 * @module @nextnowlabs/dsh-lark/agent-preset
 */

import { agentPresetCard } from './cards.ts'
import { marked } from './clicks.ts'
import type { ConversationSubject } from './session.ts'

/** Show or switch this conversation's Agent preset. Channel-owned: needs no agent. */
export const AGENT_COMMAND = 'agent'

/** Marks this plugin's agent-preset buttons apart from other card actions. */
export const AGENT_ACTION = 'dsh-lark/agent'

/** The typed word that returns a conversation to the deployment default. */
export const RESET_KEYWORD = 'reset'

/** Entry value marking "explicitly the default": a deep-merged patch cannot delete a key. */
const DEFAULT_MARKER = ''

/** One preset the deployment's roster declares, as this channel shows it. */
export interface AgentChoice {
  /** The preset id a typed switch addresses. */
  readonly id: string
  /** The host's display name, when the declaration set one. */
  readonly name?: string | undefined
  /** The host's one-line description, when the declaration set one. */
  readonly description?: string | undefined
  /** Why this preset cannot be joined, when it cannot. */
  readonly broken?: string | undefined
}

/**
 * How one choice is named in a sentence: the host's own words when it wrote
 * any, the id that a typed form takes otherwise.
 * @param choice - the preset to name.
 * @returns the label.
 */
export function choiceLabel(choice: Pick<AgentChoice, 'id' | 'name'>): string {
  return choice.name === undefined || choice.name === '' ? choice.id : choice.name
}

/** Card payload carried by one preset pick. */
export interface AgentActionValue extends ConversationSubject {
  readonly kind: typeof AGENT_ACTION
  /** The preset to switch to; absent means "back to the deployment default". */
  readonly preset?: string | undefined
}

/**
 * Narrow an arbitrary card-action value to this module's pick payload.
 * @param value - raw button value from a card action event.
 * @returns the typed payload, or undefined for foreign card actions.
 */
export function agentActionValue(value: unknown): AgentActionValue | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (record.kind !== AGENT_ACTION) return undefined
  if (typeof record.key !== 'string' || record.key === '') return undefined
  if (typeof record.chatId !== 'string' || record.chatId === '') return undefined
  if (typeof record.chatType !== 'string') return undefined
  if (record.owner !== undefined && typeof record.owner !== 'string') return undefined
  if (record.preset !== undefined && (typeof record.preset !== 'string' || record.preset === '')) return undefined
  return {
    kind: AGENT_ACTION,
    key: record.key,
    chatId: record.chatId,
    chatType: record.chatType,
    ...record.owner === undefined ? {} : { owner: record.owner },
    ...record.preset === undefined ? {} : { preset: record.preset },
  }
}

/** What one preset store write concluded. */
export interface PresetChange {
  /** False when the conversation was already on that answer. */
  readonly changed: boolean
  /** Whether the mapping survives a restart. */
  readonly durable: boolean
}

/** Construction options for {@link ChatPresets}. */
export interface ChatPresetsOptions {
  /** Persisted conversation-key → preset id; {@link DEFAULT_MARKER} means default. */
  readonly entries?: Record<string, string> | undefined
  /** Merge one patch into this channel's durable store; false = not durable. */
  readonly persist?: ((patch: { chatPresets: Record<string, string> }) => Promise<boolean>) | undefined
  /** Operator console line. */
  readonly report?: ((line: string) => void) | undefined
}

/**
 * The per-conversation Agent preset choice, against the deployment default
 * meaning "no entry". Pure state plus injected persistence, mirroring the
 * workspace and model stores.
 */
export class ChatPresets {
  private readonly entries: Map<string, string>
  private readonly persist: (patch: { chatPresets: Record<string, string> }) => Promise<boolean>
  private readonly report: (line: string) => void
  /** The non-durable warning is orientation; once is enough. */
  private warnedNotDurable = false

  constructor(options: ChatPresetsOptions = {}) {
    this.entries = new Map(Object.entries(options.entries ?? {}))
    this.persist = options.persist ?? (async () => false)
    this.report = options.report ?? (() => {})
  }

  /**
   * The preset one conversation asked for, or undefined for the deployment
   * default.
   * @param key - the conversation key.
   * @returns the preset id, or undefined.
   */
  presetFor(key: string): string | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined || entry === DEFAULT_MARKER || entry === '') return undefined
    return entry
  }

  /** Whether one conversation runs on the deployment default. */
  isDefault(key: string): boolean {
    return this.presetFor(key) === undefined
  }

  /**
   * Point one conversation at a preset.
   * @param key - the conversation key.
   * @param preset - the preset id.
   * @returns whether it changed, and whether the value is durable.
   */
  async set(key: string, preset: string): Promise<PresetChange> {
    return await this.record(key, preset)
  }

  /**
   * Return one conversation to the deployment default.
   * @param key - the conversation key.
   * @returns whether it changed, and whether the value is durable.
   */
  async reset(key: string): Promise<PresetChange> {
    return await this.record(key, DEFAULT_MARKER)
  }

  private async record(key: string, value: string): Promise<PresetChange> {
    const changed = (this.entries.get(key) ?? DEFAULT_MARKER) !== value
    this.entries.set(key, value)
    let durable = true
    if (changed) {
      durable = await this.persist({ chatPresets: { [key]: value } }).catch((error: unknown) => {
        this.report(`lark-channel: persisting the Agent preset switch failed: ${String(error)}`)
        return false
      })
      if (!durable && !this.warnedNotDurable) {
        this.warnedNotDurable = true
        this.report(
          'lark-channel: Agent preset switches are in-memory only (no durable storage); they reset on restart',
        )
      }
    }
    return { changed, durable }
  }
}

/** What one switch concluded, as the caller reports it. */
export interface AgentSwitch {
  /** False when the conversation was already on that preset. */
  readonly changed: boolean
  /** Whether the choice AND the fresh session id survive a restart. */
  readonly durable: boolean
  /** Whether a session was retired, so the next message starts a new one. */
  readonly restarted: boolean
}

/**
 * Record one choice and, when it changed something, retire the conversation's
 * current session so the next message starts under it.
 *
 * The order is load-bearing: the mapping is written BEFORE the restart, so a
 * message that arrives while the release is still tearing the old agent down
 * already derives its session id under the new preset. A restart that fails
 * leaves the choice in place — the conversation's next message still starts a
 * new session — which is why the mapping is not rolled back.
 * @param store - the preset state.
 * @param key - the conversation key.
 * @param preset - the preset id, or undefined for the deployment default.
 * @param restart - retires the current session and derives a new id; resolves
 *   whether that new id survives a restart.
 * @returns what the caller should say about it.
 */
export async function switchAgentPreset(
  store: ChatPresets,
  key: string,
  preset: string | undefined,
  restart: () => Promise<boolean>,
): Promise<AgentSwitch> {
  const change = preset === undefined ? await store.reset(key) : await store.set(key, preset)
  if (!change.changed) return { changed: false, durable: change.durable, restarted: false }
  const restarted = await restart()
  return { changed: true, durable: change.durable && restarted, restarted: true }
}

/** What one `/agent` line produced: a card to send, or a line of markdown. */
export type AgentReply = { readonly card: object } | { readonly markdown: string }

/** What {@link runAgentCommand} needs from the bridge. */
export interface AgentCommandPorts {
  /** The deployment's preset roster; empty when none is composed. */
  readonly catalog: () => Promise<readonly AgentChoice[]>
  /** The deployment default's display label, resolved without an agent. */
  readonly defaultLabel: () => Promise<string>
  /**
   * Retire the conversation's current session and derive a fresh id for the
   * next message; resolves whether that id survives a restart.
   */
  readonly restart: () => Promise<boolean>
}

/**
 * The note a switch appends when its durability could not be promised.
 * @param durable - whether the choice and the new session id are stored.
 * @returns the sentence, empty when they are.
 */
function durabilityNote(durable: boolean): string {
  return durable ? '' : '\n（本部署没有可用的持久化存储，这次切换和新的会话 id 在重启后会丢失。）'
}

/**
 * What the chat is told once a switch landed. The reset of context is stated
 * plainly and first: it is the one consequence a preset change cannot avoid,
 * and the previous session is named as recoverable rather than lost.
 * @param label - the preset's display label.
 * @param durable - whether the switch survives a restart.
 * @returns the markdown reply.
 */
export function agentSwitchedText(label: string, durable: boolean): string {
  return `🤖 已切到「${label}」，下一条消息从新会话开始（Agent 预设不能中途换）。`
    + '\n原会话仍然保留，发 `/sessions` 可以接回去。'
    + durabilityNote(durable)
}

/**
 * What the chat is told when a conversation returns to the deployment default.
 * @param label - the default's display label.
 * @param durable - whether the switch survives a restart.
 * @returns the markdown reply.
 */
export function agentResetText(label: string, durable: boolean): string {
  return `🤖 已回到默认 Agent 预设「${label}」，下一条消息从新会话开始。`
    + '\n原会话仍然保留，发 `/sessions` 可以接回去。'
    + durabilityNote(durable)
}

/**
 * The picker one conversation is shown, whether it asked by typing `/agent`
 * or pressed a row on an earlier rendering.
 *
 * Both callers build the card through here so a repaint cannot describe the
 * roster differently from the card it replaces — and every payload is stamped
 * with its own rendering mark, because a picker that stays in the chat is
 * meant to be pressed again.
 * @param subject - the conversation the card governs, and where it lives.
 * @param catalog - the roster, in its declared order.
 * @param chosen - the preset this conversation picked, if it did.
 * @param defaultLabel - the deployment default's display label.
 * @returns a schema 2.0 card object.
 */
export function agentPresetPicker(
  subject: ConversationSubject,
  catalog: readonly AgentChoice[],
  chosen: string | undefined,
  defaultLabel: string,
): object {
  const pick = (preset?: string): AgentActionValue => marked({
    kind: AGENT_ACTION,
    key: subject.key,
    chatId: subject.chatId,
    chatType: subject.chatType,
    ...subject.owner === undefined ? {} : { owner: subject.owner },
    ...preset === undefined ? {} : { preset },
  })
  const current = chosen === undefined ? undefined : catalog.find(choice => choice.id === chosen)
  return agentPresetCard({
    // A choice the roster no longer declares is still named: the conversation
    // did choose it, and hiding that would make the card's current state a lie.
    current: current === undefined ? chosen ?? defaultLabel : choiceLabel(current),
    isDefault: chosen === undefined,
    entries: catalog.map(choice => ({
      id: choice.id,
      label: choiceLabel(choice),
      detail: detailOf(choice),
      current: choice.id === chosen,
      broken: choice.broken,
      value: pick(choice.id),
    })),
    ...chosen === undefined ? {} : { reset: pick() },
  })
}

/**
 * Run one `/agent` command line and produce the chat reply.
 *
 * The bare form answers with the picker; every other form answers in text,
 * because typing `/agent <id>` is what someone does when they already know
 * what they want. `reset` is reserved rather than usable as a preset id — a
 * roster may name a preset anything, but this word means "the default" here
 * and says so in the usage line.
 * @param line - the complete line, slash included.
 * @param subject - the conversation the command is about, and where it lives.
 * @param store - the preset state.
 * @param ports - the roster, the default label, and the restart hook.
 * @returns the card or the markdown for the chat.
 */
export async function runAgentCommand(
  line: string,
  subject: ConversationSubject,
  store: ChatPresets,
  ports: AgentCommandPorts,
): Promise<AgentReply> {
  const key = subject.key
  const argument = line.trimStart().slice(1 + AGENT_COMMAND.length).trim()
  const [verb] = argument.split(/\s+/).filter(part => part !== '')
  const chosen = store.presetFor(key)

  if (verb === undefined) {
    const catalog = await ports.catalog()
    const defaultLabel = await ports.defaultLabel()
    return { card: agentPresetPicker(subject, catalog, chosen, defaultLabel) }
  }

  if (verb === RESET_KEYWORD) {
    const label = await ports.defaultLabel()
    const outcome = await switchAgentPreset(store, key, undefined, ports.restart)
    if (!outcome.changed) return { markdown: `🤖 本会话已经在用默认 Agent 预设「${label}」。` }
    return { markdown: agentResetText(label, outcome.durable) }
  }

  const catalog = await ports.catalog()
  const choice = catalog.find(candidate => candidate.id === verb)
  if (choice === undefined) {
    const available = catalog.length === 0
      ? '本部署没有声明任何 Agent 预设。'
      : `可用的预设：${catalog.map(candidate => `\`${candidate.id}\``).join('、')}。`
    return { markdown: `⚠️ 没有名为 \`${verb}\` 的 Agent 预设。${available}` }
  }
  if (choice.broken !== undefined) {
    return { markdown: `⚠️ Agent 预设「${choiceLabel(choice)}」无法加载：${choice.broken}` }
  }
  const outcome = await switchAgentPreset(store, key, choice.id, ports.restart)
  if (!outcome.changed) return { markdown: `🤖 本会话已经在用「${choiceLabel(choice)}」。` }
  return { markdown: agentSwitchedText(choiceLabel(choice), outcome.durable) }
}

/**
 * The line under a preset's name: what someone would type, then the host's
 * description. Both are foreign text and ride a plain-text element.
 * @param choice - the preset.
 * @returns the detail line, or undefined when there is nothing to add.
 */
function detailOf(choice: AgentChoice): string | undefined {
  const parts = [
    choice.name === undefined || choice.name === '' || choice.name === choice.id ? undefined : choice.id,
    choice.description,
  ].filter((part): part is string => part !== undefined && part !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

import { describe, expect, it } from 'vitest'
import {
  AGENT_ACTION,
  ChatPresets,
  agentActionValue,
  agentPresetPicker,
  choiceLabel,
  runAgentCommand,
  switchAgentPreset,
} from '../src/agent-preset.ts'
import type { AgentChoice, AgentCommandPorts } from '../src/agent-preset.ts'
import { cardControls, cardTexts } from './harness.ts'

const choices: AgentChoice[] = [
  { id: 'standard', name: '标准模式', description: '日常任务' },
  { id: 'bid', name: '国网招投标' },
]

const subject = { key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' }

/** A store recording persisted patches. */
function createStore(options: { entries?: Record<string, string>; persisted?: boolean } = {}) {
  const patches: object[] = []
  const reports: string[] = []
  const store = new ChatPresets({
    entries: options.entries,
    persist: async (patch) => {
      patches.push(patch)
      return options.persisted ?? true
    },
    report: (line) => { reports.push(line) },
  })
  return { store, patches, reports }
}

/** Ports over a fixed roster, counting restarts. */
function createPorts(catalog: readonly AgentChoice[] = choices, durable = true) {
  const state = { restarts: 0 }
  const ports: AgentCommandPorts = {
    catalog: async () => catalog,
    defaultLabel: async () => '标准模式',
    restart: async () => {
      state.restarts += 1
      return durable
    },
  }
  return { state, ports }
}

describe('the preset store', () => {
  it('reads an absent or marker entry as the deployment default', async () => {
    const { store } = createStore({ entries: { oc_1: '', oc_2: 'bid' } })
    expect(store.presetFor('oc_1')).toBeUndefined()
    expect(store.isDefault('oc_1')).toBe(true)
    expect(store.presetFor('oc_2')).toBe('bid')
    expect(store.isDefault('oc_2')).toBe(false)
    expect(store.presetFor('oc_3')).toBeUndefined()
  })

  it('persists only a change, and reports the patch it wrote', async () => {
    const { store, patches } = createStore()
    expect(await store.set('oc_1', 'bid')).toEqual({ changed: true, durable: true })
    expect(patches).toEqual([{ chatPresets: { oc_1: 'bid' } }])
    // Setting the same preset again is not a write.
    expect(await store.set('oc_1', 'bid')).toEqual({ changed: false, durable: true })
    expect(patches).toHaveLength(1)
    expect(await store.reset('oc_1')).toEqual({ changed: true, durable: true })
    expect(patches.at(-1)).toEqual({ chatPresets: { oc_1: '' } })
  })

  it('keeps working in memory when persistence refuses, and says so once', async () => {
    const { store, reports } = createStore({ persisted: false })
    expect(await store.set('oc_1', 'bid')).toEqual({ changed: true, durable: false })
    expect(store.presetFor('oc_1')).toBe('bid')
    await store.set('oc_2', 'standard')
    expect(reports.filter(line => line.includes('in-memory only'))).toHaveLength(1)
  })
})

describe('card payloads', () => {
  it('reads its own pick, with or without a preset', () => {
    expect(agentActionValue({ kind: AGENT_ACTION, key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' }))
      .toEqual({ kind: AGENT_ACTION, key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' })
    expect(agentActionValue({
      kind: AGENT_ACTION, key: 'oc_1', chatId: 'oc_1', chatType: 'p2p', preset: 'bid', a: 'mark',
    })).toMatchObject({ preset: 'bid' })
  })

  it('refuses foreign, malformed, and blank-preset payloads', () => {
    expect(agentActionValue(undefined)).toBeUndefined()
    expect(agentActionValue({ kind: 'dsh-lark/model', key: 'oc_1', chatId: 'oc_1', chatType: 'p2p' }))
      .toBeUndefined()
    expect(agentActionValue({ kind: AGENT_ACTION, key: '', chatId: 'oc_1', chatType: 'p2p' }))
      .toBeUndefined()
    expect(agentActionValue({ kind: AGENT_ACTION, key: 'oc_1', chatId: 'oc_1', chatType: 'p2p', preset: '' }))
      .toBeUndefined()
  })

  it('labels a choice by the host name, falling back to the id', () => {
    expect(choiceLabel({ id: 'bid', name: '国网招投标' })).toBe('国网招投标')
    expect(choiceLabel({ id: 'bid' })).toBe('bid')
    expect(choiceLabel({ id: 'bid', name: '' })).toBe('bid')
  })
})

describe('switching', () => {
  it('does not restart a session when the choice did not change', async () => {
    const { store } = createStore({ entries: { oc_1: 'bid' } })
    const restart = async (): Promise<boolean> => { throw new Error('must not restart') }
    expect(await switchAgentPreset(store, 'oc_1', 'bid', restart))
      .toEqual({ changed: false, durable: true, restarted: false })
  })

  it('restarts on a change, and promises durability only when both halves are stored', async () => {
    const { store } = createStore()
    const outcome = await switchAgentPreset(store, 'oc_1', 'bid', async () => true)
    expect(outcome).toEqual({ changed: true, durable: true, restarted: true })

    const inMemory = createStore({ persisted: false })
    const lossy = await switchAgentPreset(inMemory.store, 'oc_1', 'bid', async () => false)
    expect(lossy).toEqual({ changed: true, durable: false, restarted: true })
  })
})

describe('the picker card', () => {
  it('offers every preset, states the current one, and carries a reset only when chosen', async () => {
    const pick = agentPresetPicker(subject, choices, undefined, '标准模式')
    expect(pick).toMatchObject({ schema: '2.0' })
    const texts = cardTexts(pick).map(text => text.content)
    expect(texts).toContain('标准模式')
    expect(texts).toContain('国网招投标')
    expect(texts.some(text => text.includes('下一条消息使用'))).toBe(true)
    const controls = cardControls(pick)
    // Both presets are offered; the deployment default is stated, not pressed.
    expect(controls.map(control => (control.value as { preset?: string }).preset))
      .toEqual(expect.arrayContaining(['standard', 'bid']))
    expect(controls.some(control => (control.value as { preset?: string }).preset === undefined)).toBe(false)
  })

  it('settles the chosen preset and offers the way back', () => {
    const pick = agentPresetPicker(subject, choices, 'bid', '标准模式')
    const controls = cardControls(pick).map(control => control.value as { preset?: string })
    // The chosen row is no longer pressable...
    expect(controls.some(value => value.preset === 'bid')).toBe(false)
    // ...and the reset control carries no preset, meaning the default.
    expect(controls.some(value => value.preset === undefined)).toBe(true)
  })

  it('shows a preset that failed to compose without offering it', () => {
    const pick = agentPresetPicker(
      subject,
      [...choices, { id: 'broken', name: '坏掉的', broken: 'its row failed' }],
      undefined,
      '标准模式',
    )
    const controls = cardControls(pick).map(control => control.value as { preset?: string })
    expect(controls.some(value => value.preset === 'broken')).toBe(false)
    expect(cardTexts(pick).map(text => text.content)).toContain('加载失败，暂时不能切换')
  })
})

describe('/agent', () => {
  it('answers a bare line with the picker, without restarting anything', async () => {
    const { store } = createStore()
    const { state, ports } = createPorts()
    const reply = await runAgentCommand('/agent', subject, store, ports)
    expect('card' in reply).toBe(true)
    expect(state.restarts).toBe(0)
  })

  it('switches on a typed id: record, restart, and say the context resets', async () => {
    const { store, patches } = createStore()
    const { state, ports } = createPorts()
    const reply = await runAgentCommand('/agent bid', subject, store, ports)
    expect(reply).toMatchObject({ markdown: expect.stringContaining('国网招投标') })
    if ('markdown' in reply) expect(reply.markdown).toContain('新会话')
    expect(store.presetFor('oc_1')).toBe('bid')
    expect(patches).toEqual([{ chatPresets: { oc_1: 'bid' } }])
    expect(state.restarts).toBe(1)
  })

  it('says it is already in use without restarting a second time', async () => {
    const { store } = createStore({ entries: { oc_1: 'bid' } })
    const { state, ports } = createPorts()
    const reply = await runAgentCommand('/agent bid', subject, store, ports)
    expect(reply).toMatchObject({ markdown: expect.stringContaining('已经在用') })
    expect(state.restarts).toBe(0)
  })

  it('names the available ids for an unknown one', async () => {
    const { store } = createStore()
    const { state, ports } = createPorts()
    const reply = await runAgentCommand('/agent nope', subject, store, ports)
    expect(reply).toMatchObject({ markdown: expect.stringContaining('没有名为 `nope`') })
    if ('markdown' in reply) expect(reply.markdown).toContain('`bid`')
    expect(state.restarts).toBe(0)
  })

  it('refuses a preset the roster could not compose, in the roster\'s words', async () => {
    const { store } = createStore()
    const { state, ports } = createPorts([{ id: 'broken', broken: 'its row failed' }])
    const reply = await runAgentCommand('/agent broken', subject, store, ports)
    expect(reply).toMatchObject({ markdown: expect.stringContaining('its row failed') })
    expect(state.restarts).toBe(0)
  })

  it('returns to the deployment default on reset', async () => {
    const { store, patches } = createStore({ entries: { oc_1: 'bid' } })
    const { state, ports } = createPorts()
    const reply = await runAgentCommand('/agent reset', subject, store, ports)
    expect(reply).toMatchObject({ markdown: expect.stringContaining('标准模式') })
    expect(store.presetFor('oc_1')).toBeUndefined()
    expect(patches.at(-1)).toEqual({ chatPresets: { oc_1: '' } })
    expect(state.restarts).toBe(1)
  })

  it('says there is nothing to choose when the deployment declares no preset', async () => {
    const { store } = createStore()
    const { ports } = createPorts([])
    const picker = await runAgentCommand('/agent', subject, store, ports)
    expect('card' in picker).toBe(true)
    const typed = await runAgentCommand('/agent standard', subject, store, ports)
    expect(typed).toMatchObject({ markdown: expect.stringContaining('没有声明任何 Agent 预设') })
  })
})

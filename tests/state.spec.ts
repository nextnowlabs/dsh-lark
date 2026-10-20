/**
 * The store this channel keeps its own state in.
 *
 * Two things are worth a test here rather than a deployment. The first is that
 * the domain spec this package declares is one the HOST accepts: it is written
 * as a structural literal so the package keeps building without a host import,
 * which also means nothing but this file would notice a host that tightened its
 * validation — and the place that would notice instead is a bot's first boot.
 * The second is the degradation the rest of the channel is written against: a
 * deployment with no storage still runs, remembers for the process, and says so.
 * @module tests/state.spec
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import * as jsonBackend from '@deepseek-ai/dsh-storage-json'
import * as storageDomain from '@deepseek-ai/dsh-storage-domain'
import { Storage } from '@deepseek-ai/dsh-storage'
import { channelDomainSpec, openStateStore, STATE_TABLES } from '../src/state.ts'
import type { StateStore } from '../src/state.ts'
import { instanceIdentity } from '../src/instance.ts'

describe('the declared state domain', () => {
  it('is a spec the host itself would accept', () => {
    // Opened through the HOST's own defineDomain, which is what validates a
    // name against the backend's grammar and refuses a nullable global.
    for (const identity of [instanceIdentity(), instanceIdentity('cn-ops')]) {
      const spec = channelDomainSpec(identity.stateDomain) as Parameters<typeof defineDomain>[0]
      expect(() => defineDomain(spec)).not.toThrow()
      expect(spec.name).toBe(identity.stateDomain)
      expect(Object.keys(spec.tables)).toEqual(Object.values(STATE_TABLES))
    }
  })

  it('names its tables and domain the way a backend unit name allows', () => {
    // A domain name doubles as a file name and a SQL identifier segment, so a
    // dash — which this plugin's own names are spelled with — would fail at
    // open rather than at build.
    const UNIT_NAME = /^[a-z][a-z0-9_]*$/
    for (const identity of [instanceIdentity(), instanceIdentity('cn-ops'), instanceIdentity('9x')]) {
      expect(identity.stateDomain).toMatch(UNIT_NAME)
      expect(Object.values(STATE_TABLES).every(table => UNIT_NAME.test(table))).toBe(true)
    }
  })

  it('declares a record and global schema the host can validate with', () => {
    const spec = channelDomainSpec('lark_channel') as {
      tables: Record<string, { valueSchema: { parse(value: unknown): unknown } }>
      global: { schema: { safeParse(value: unknown): { success: boolean } }; initial: unknown }
    }
    // Everything this channel stores is a string: the maps always were, and a
    // hand-edited medium must not hand the transport a number for an app id.
    expect(spec.tables[STATE_TABLES.chatWorkspaces]!.valueSchema.parse('a-path')).toBe('a-path')
    expect(() => spec.tables[STATE_TABLES.chatModels]!.valueSchema.parse(7)).toThrow()
    expect(spec.global.initial).toEqual({})
  })
})

describe('opening the store', () => {
  it('reads back what it wrote, and drops an emptied scalar', async () => {
    const domain = memoryDomain()
    const store = await openStateStore({ open: async () => domain.service }, 'lark_channel', () => {})
    expect(store.snapshot()).toEqual({
      chatWorkspaces: {}, chatModels: {}, chatEpochs: {}, chatSessions: {}, chatPresets: {},
    })

    expect(await store.apply({ chatWorkspaces: { oc_1: '/tmp/a' } })).toBe(true)
    expect(await store.apply({ appId: 'cli_1', appSecretRef: 'LARK_APP_SECRET' })).toBe(true)
    expect(store.snapshot()).toMatchObject({
      chatWorkspaces: { oc_1: '/tmp/a' },
      appId: 'cli_1',
      appSecretRef: 'LARK_APP_SECRET',
    })

    // Blanking a scalar REMOVES it: an empty secret is an absent one everywhere
    // in this channel, and the global is one JSON record rather than a document
    // a deep merge can only ever add to.
    await store.apply({ appSecret: '' })
    expect(store.snapshot().appSecret).toBeUndefined()
    expect(domain.global()).toEqual({ appId: 'cli_1', appSecretRef: 'LARK_APP_SECRET' })
    await store.close()
  })

  it('keeps a scalar a later write did not name', async () => {
    const domain = memoryDomain({ appId: 'cli_1', appSecret: 'literal' })
    const store = await openStateStore({ open: async () => domain.service }, 'lark_channel', () => {})
    await store.apply({ appSecretRef: 'LARK_APP_SECRET' })
    // The global is rewritten whole, so a writer that sent only its own field
    // must not drop the ones it never mentioned.
    expect(domain.global()).toEqual({ appId: 'cli_1', appSecret: 'literal', appSecretRef: 'LARK_APP_SECRET' })
    await store.close()
  })

  it('survives a restart, which is the whole point of it', async () => {
    const medium = memoryDomain()
    const first = await openStateStore({ open: async () => medium.service }, 'lark_channel', () => {})
    await first.apply({ chatEpochs: { 'lark-oc_1': '2' }, appId: 'cli_1' })
    await first.close()

    // A second process over the same medium: what a `/new` recorded is still
    // what this conversation resolves to.
    const second = await openStateStore({ open: async () => medium.reopen() }, 'lark_channel', () => {})
    expect(second.snapshot()).toMatchObject({ chatEpochs: { 'lark-oc_1': '2' }, appId: 'cli_1' })
    await second.close()
  })

  it('degrades to memory rather than failing when no domain can be opened', async () => {
    const lines: string[] = []
    const store = await openStateStore(
      { open: async () => { throw new Error('no backend is routed for this domain') } },
      'lark_channel',
      line => lines.push(line),
    )
    // The value is still visible to THIS process — a switch must take effect —
    // but the writer is told it will not survive a restart, which is what every
    // command reports to the chat.
    expect(await store.apply({ chatWorkspaces: { oc_1: '/tmp/a' } })).toBe(false)
    expect(store.snapshot().chatWorkspaces).toEqual({ oc_1: '/tmp/a' })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('durable state is unavailable')
    await store.close()
  })

  it('treats a deployment with no storage service as memory-only, silently', async () => {
    const lines: string[] = []
    const store = await openStateStore(undefined, 'lark_channel', line => lines.push(line))
    expect(await store.apply({ chatModels: { oc_1: 'p/m' } })).toBe(false)
    // Nothing is wrong: this deployment simply composed no storage, and saying
    // so on every boot would be noise rather than news.
    expect(lines).toEqual([])
    await store.close()
  })

  it('keeps its own memory in step with the medium, not ahead of it', async () => {
    // The domain's contract is that a rejected write leaves its memory
    // untouched. A mirror that folded the patch first would report a switch as
    // durable on a backend that had just refused it — and the chat would stop
    // saying "this resets on restart" at exactly the moment it does.
    const domain = memoryDomain()
    domain.failWrites()
    const store = await openStateStore({ open: async () => domain.service }, 'lark_channel', () => {})
    await expect(store.apply({ chatWorkspaces: { oc_1: '/tmp/a' } })).rejects.toThrow('medium is read-only')
    expect(store.snapshot().chatWorkspaces).toEqual({})
    await store.close()
  })

  it('refuses further writes once closed, rather than dropping them quietly', async () => {
    const domain = memoryDomain()
    const store = await openStateStore({ open: async () => domain.service }, 'lark_channel', () => {})
    await store.close()
    expect(await store.apply({ chatWorkspaces: { oc_1: '/tmp/a' } })).toBe(false)
  })
})

/**
 * One domain over a medium that outlives the handle, so a test can model a
 * restart the way the backend does.
 * @param seed - scalars the medium already holds.
 * @returns the current handle, a reopen, and readers for what is stored.
 */
function memoryDomain(seed: Record<string, string> = {}) {
  const tables = new Map<string, Map<string, string>>()
  for (const table of Object.values(STATE_TABLES)) tables.set(table, new Map())
  let global: Record<string, string> = { ...seed }
  let writable = true
  const service = () => ({
    global: {
      get: () => ({ ...global }),
      set: async (value: unknown) => { global = { ...(value as Record<string, string>) } },
    },
    table: (name: string) => {
      const records = tables.get(name)!
      return {
        get: (key: string) => records.get(key),
        keys: () => records.keys(),
        put: async (key: string, value: unknown) => {
          if (!writable) throw new Error('medium is read-only')
          records.set(key, String(value))
        },
        delete: async (key: string) => records.delete(key),
      }
    },
    close: async () => undefined,
  })
  return {
    service: service(),
    reopen: service,
    global: () => ({ ...global }),
    /** Model a medium that refuses writes, as a full disk or a revoked mount does. */
    failWrites: () => { writable = false },
  }
}

describe('against the host storage stack', () => {
  it('opens, writes and reopens over the real hub, backend and domain form', async () => {
    // The strongest check available without booting a whole profile: the host's
    // OWN storage hub, json backend and domain facility, over a real directory.
    // Everything the production writer does — the spec it hands over, the table
    // names, the whole-global rewrite, zod validation at the durable boundary —
    // runs for real here, and the medium is inspected as the file it is.
    const dir = mkdtempSync(join(tmpdir(), 'lark-state-'))
    const ctx = new Context()
    const fibers = [
      await ctx.plugin(Storage),
      // Passed as explicit plugin objects: a bare `apply` would drop the
      // `inject` each one declares, and a module namespace carries a `default`
      // that Cordis would rather instantiate.
      await ctx.plugin({ name: jsonBackend.name, inject: jsonBackend.inject, apply: jsonBackend.apply }, { root: dir }),
      await ctx.plugin(
        { name: storageDomain.name, inject: storageDomain.inject, apply: storageDomain.apply },
        { backend: 'json' },
      ),
    ]
    try {
      const open = async (): Promise<StateStore> => openStateStore(
        { open: spec => ctx.storageDomain.open(spec as Parameters<typeof defineDomain>[0]) },
        'lark_channel',
        () => {},
      )

      const store = await open()
      expect(await store.apply({
        chatWorkspaces: { oc_1: '/tmp/a' },
        appId: 'cli_1',
        appSecretRef: 'LARK_APP_SECRET',
      })).toBe(true)
      await store.close()

      const medium = JSON.parse(readFileSync(join(dir, 'lark_channel.json'), 'utf8')) as {
        unit: { name: string; version: number }
        global: Record<string, unknown>
        tables: Record<string, Record<string, unknown>>
      }
      expect(medium.unit).toMatchObject({ name: 'lark_channel', version: 1 })
      expect(medium.global).toEqual({ appId: 'cli_1', appSecretRef: 'LARK_APP_SECRET' })
      expect(medium.tables.chat_workspaces).toEqual({ oc_1: '/tmp/a' })

      // A second boot reads the same conversation back, which is the property
      // the whole migration exists to restore.
      const reopened = await open()
      expect(reopened.snapshot()).toMatchObject({
        chatWorkspaces: { oc_1: '/tmp/a' },
        appId: 'cli_1',
        appSecretRef: 'LARK_APP_SECRET',
      })
      await reopened.close()
    } finally {
      for (const fiber of fibers.reverse()) await fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

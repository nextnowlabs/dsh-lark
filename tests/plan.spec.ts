import { describe, expect, it } from 'vitest'
import { firstHeading, PLAN_TOOL, planModeActive, planReviewQuestion, shadowPlanTool } from '../src/plan.ts'
import type { PlanReviewPorts } from '../src/plan.ts'
import type { HostAgent } from '../src/host.ts'
import { assertRegistrableTool } from './harness.ts'

/** The tool as the registry hands it back, with the one method tests drive. */
interface Runnable {
  readonly name: string
  execute(args: unknown, exec: unknown): Promise<{ approved: true }>
}

/** One agent; the plan service is what says whether a review is meaningful. */
function fakeAgent(): HostAgent {
  return { id: 's1', session: { id: 's1' }, followup: () => {}, cancel: () => {} } as unknown as HostAgent
}

/** Ports recording what the review published and how it was answered. */
function createPorts(
  answer: { selected: string[]; custom?: string },
  options: { planMode?: boolean; active?: boolean } = {},
) {
  const published: string[] = []
  const headings: (string | undefined)[] = []
  const switched: boolean[] = []
  const ports: PlanReviewPorts = {
    publish: async (_sessionId, plan) => { published.push(plan) },
    review: async (_sessionId, heading) => {
      headings.push(heading)
      return answer
    },
    planMode: () => options.planMode === false
      ? undefined
      : {
          set: (_agent, active) => { switched.push(active); return 'queued' },
          get: () => ({ active: options.active ?? true }),
        },
  }
  return { ports, published, headings, switched }
}

/** The plan a well-behaved model presents. */
const PLAN = '# 迁移计划\n\n1. 跑测试\n2. 发预发'

describe('plan review', () => {
  it('reads plan mode from the service that owns it', () => {
    const agent = fakeAgent()
    const reads: { active: boolean }[] = []
    const service = {
      set: () => 'queued' as const,
      get: () => reads[reads.length - 1] ?? { active: false },
    }
    reads.push({ active: false })
    expect(planModeActive(service, agent)).toBe(false)
    reads.push({ active: true })
    expect(planModeActive(service, agent)).toBe(true)
    // A service that cannot answer, and a deployment that composed none, both
    // read as "in plan mode": refusing a review the host would have run is the
    // failure this guard exists to prevent.
    expect(planModeActive({ set: () => 'queued', get: () => { throw new Error('no state') } }, agent)).toBe(true)
    expect(planModeActive(undefined, agent)).toBe(true)
  })

  it('titles the card with the plan\'s own heading', () => {
    expect(firstHeading(PLAN)).toBe('迁移计划')
    expect(firstHeading('no heading here')).toBeUndefined()
    expect(planReviewQuestion('迁移计划').header).toBe('迁移计划')
    expect(planReviewQuestion(undefined).header).toBe('计划待确认')
    // Two ways out, and each says what it does.
    expect(planReviewQuestion(undefined).options).toHaveLength(2)
  })

  it('registers as a definition the host registry would accept', () => {
    const { ports } = createPorts({ selected: [] })
    assertRegistrableTool(shadowPlanTool(ports) as { name: string })
    expect((shadowPlanTool(ports) as Runnable).name).toBe(PLAN_TOOL)
  })

  it('publishes the plan, then leaves plan mode on approval', async () => {
    const { ports, published, headings, switched } = createPorts({ selected: ['批准，开始执行'] })
    const tool = shadowPlanTool(ports) as Runnable

    expect(await tool.execute({ plan: PLAN }, { agent: fakeAgent() })).toEqual({ approved: true })
    // The plan goes out whole, as the model wrote it.
    expect(published).toEqual([PLAN])
    expect(headings).toEqual(['迁移计划'])
    expect(switched).toEqual([false])
  })

  it('stays in plan mode on every answer that is not approval', async () => {
    const kept = createPorts({ selected: ['继续规划'] })
    await expect((shadowPlanTool(kept.ports) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('revise the plan and present it again')
    expect(kept.switched).toEqual([])

    // Typed words are feedback the model revises against, so they ride back.
    const feedback = createPorts({ selected: [], custom: '回滚方案还没写' })
    await expect((shadowPlanTool(feedback.ports) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('回滚方案还没写')
    expect(feedback.switched).toEqual([])

    // A dismissed review is someone about to speak: stop, do not re-present.
    const dismissed = createPorts({ selected: [] })
    await expect((shadowPlanTool(dismissed.ports) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('wait for their message')
    expect(dismissed.switched).toEqual([])
  })

  it('refuses before it publishes anything the chat would have to read', async () => {
    const outside = createPorts({ selected: ['批准，开始执行'] }, { active: false })
    await expect((shadowPlanTool(outside.ports) as Runnable)
      .execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('only available in plan mode')

    const headless = createPorts({ selected: ['批准，开始执行'] })
    await expect((shadowPlanTool(headless.ports) as Runnable)
      .execute({ plan: '步骤一' }, { agent: fakeAgent() }))
      .rejects.toThrow('# heading')

    const noService = createPorts({ selected: ['批准，开始执行'] }, { planMode: false })
    await expect((shadowPlanTool(noService.ports) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .rejects.toThrow('no plan-mode service')

    // None of those reached the chat: a refusal the model can act on is not
    // worth a message the human has to read.
    expect([...outside.published, ...headless.published, ...noService.published]).toEqual([])
  })

  it('reviews anyway when the plan service cannot report its own state', async () => {
    const { ports, switched } = createPorts({ selected: ['批准，开始执行'] })
    const unreadable: PlanReviewPorts = {
      ...ports,
      planMode: () => ({ set: (_agent, active) => { switched.push(active); return 'queued' }, get: () => { throw new Error('no state') } }),
    }
    expect(await (shadowPlanTool(unreadable) as Runnable).execute({ plan: PLAN }, { agent: fakeAgent() }))
      .toEqual({ approved: true })
    expect(switched).toEqual([false])
  })
})

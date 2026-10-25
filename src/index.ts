/**
 * dsh-sidenote host half（Workitem_06：reflow 注入通道对齐官方侧会话提案）。
 *
 * 职责：POST /sidenote/reflow——把回流内容以 `agent.inject(UserMessage,
 * {source:{kind:'plugin', plugin:'dsh-sidenote', form:'notice', summary}})`
 * 注入父会话日志（下轮领取、不唤醒；对齐 2026-07-08 官方侧会话提案的
 * handback 语义——其 `context/message` 形态在 07-20 去封套时移除，inject
 * 是现行等价物，见 Workitem_01 spike 的 design.md）。
 *
 * 为什么需要宿主半包：`agent.inject` 只在宿主侧可达（agents registry）；
 * 客户端的 session.prompt 只有 queue/steer（会唤醒开轮次，语义不符）。
 *
 * 降级纪律：webServer 面缺席（headless/CLI 形态）→ 路由不注册，客户端
 * 回落搭车形态；agents/webRuntime 缺席 → handler 内降级（no-live-agent /
 * fence 退化为只信 loopback——fail-closed）。能力可选，绝不阻塞插件装载。
 *
 * 信任栅栏（对抗性审查 M3）：本路由能把任意文本注入用户主会话上下文
 * （间接 prompt injection 面）——每个请求先过 trust-fence（移植自
 * dsh-better-sidebar src/trust-fence.ts，BSD-3-Clause 同源复制）。
 */
import type { IncomingHttpHeaders } from 'node:http'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { isTrustedApiRequest } from './trust-fence.ts'

/** Plugin identity for cordis.yml rows. */
export const name = 'dsh-sidenote'

// 0.1.7 起 `MessageSourceMap` 不再有共享的 `plugin` catch-all kind（dsh-llm
// message.d.ts：'there is no shared catch-all plugin kind'），改为每个生产者
// 在自身模块里 declare module 扩展。本插件声明 `side-chat-reflow` 承载回流
// 注入（form:'notice' + summary 一并声明，折叠行才能显示摘要）。
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'side-chat-reflow': {
      kind: 'side-chat-reflow'
      plugin: string
      form: 'notice'
      summary: string
    }
  }
}

// ── 宿主面镜像（结构性子集；权威：dsh-better-sidebar src/context-types.ts） ────

interface HttpRequestLike {
  headers: IncomingHttpHeaders
  [Symbol.asyncIterator](): AsyncIterator<string | Uint8Array>
}

interface HttpResponseLike {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string | Uint8Array): void
}

interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: HttpRequestLike, res: HttpResponseLike) => void | Promise<void>
  }): () => void
}

/**
 * `Agent` 的结构面子集（权威：`dsh-agent-loop/lib/types/agent.d.ts` 的
 * `ReactLoopAgent`：`readonly id: SessionId` + `inject(input: UserMessage)`）。
 */
interface AgentLike {
  id?: unknown
  inject(message: unknown): void
}

/**
 * 宿主 `agents` 服务的结构面子集（`get` / `list`）。
 *
 * **必须经 `ctx.inject(['agents'], cb)` 获取，不能用静态 `ctx.get('agents')`**
 * —— cordis 的 `ctx.get` 对未在 inject 清单里的服务不可达（与本文件 webServer
 * 那段踩的是同一个坑；宿主自己的 `dsh-subagent` / `dsh-deepseek-account` 一律
 * 用 `ctx.inject(["agents"], (scope) => ...)` 后读 `scope.agents`）。
 *
 * 静态 get 恒返回 undefined → 恒判 `no-live-agent` → 回流从不注入（实测：
 * 对当前运行中的会话请求同样返回该错误，8 个近期会话里注入记录为 0）。
 */
interface AgentsLike {
  get(id: string): AgentLike | undefined
  list?(): readonly AgentLike[]
}

/** live agent 注册表（兜底：`agents` 服务缺席时靠 agent 事件自己记账）。 */
export type AgentRegistry = Map<string, AgentLike>

interface WebRuntimeLike {
  trustedHosts?: readonly string[]
}

interface HostContext {
  get(name: string): unknown
  effect(fn: () => void | (() => void), label?: string): unknown
  /** cordis 事件订阅（`agent/created` / `agent/disposed`）。返回解除函数。 */
  on(event: string, listener: (payload: unknown) => void): unknown
}

// ── wire 工具（最小集，better-sidebar src/wire.ts 同款） ────────────────────

const MAX_BODY_BYTES = 64 * 1024

async function readJsonBody(req: HttpRequestLike): Promise<unknown> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

function writeJson(res: HttpResponseLike, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

// ── 路由 ────────────────────────────────────────────────────────────────────

interface ReflowItemPayload {
  text?: unknown
  sideTitle?: unknown
}

interface ReflowPayload {
  parentSessionId?: unknown
  items?: unknown
}

export interface ReflowDiagnostics {
  /** inject(['agents']) 是否已触发（服务就绪回调跑过）。 */
  agentsInjected: boolean
  /** 注入的 scope 上 `agents` 是否为可用对象。 */
  agentsServiceSeen: boolean
  /** 自记账表里已知的 sessionId（agent/created 事件收件数）。 */
  registryIds: readonly string[]
}

/**
 * 最近若干次**来自客户端的**回流请求（仅存内存）。
 *
 * 存在的理由：回流有三段可能断掉（拦截器没触发 / store 查不到项 / 服务端注入失败），
 * 而前两段都在浏览器里、从会话日志看不见。把请求本身记下来，就能一眼分开
 * 「客户端根本没发」和「发了但服务端失败」——不用再靠猜。
 */
export interface ReflowPostLog {
  at: number
  sessionId: string
  items: number
  outcome: string
}

const recentClientPosts: ReflowPostLog[] = []
const MAX_POST_LOG = 20

function recordPost(entry: ReflowPostLog): void {
  recentClientPosts.push(entry)
  if (recentClientPosts.length > MAX_POST_LOG) recentClientPosts.shift()
}

/** reflow 注入处理：父会话 agent 在 → inject；不在 → ok:false（客户端回落搭车）。
 *  导出供单测（宿主 handler 的 fence/校验/降级路径）。 */
export function makeReflowHandler(
  ctx: HostContext,
  resolveAgent: (sessionId: string) => AgentLike | undefined = () => undefined,
  diagnose: () => ReflowDiagnostics = () => ({ agentsInjected: false, agentsServiceSeen: false, registryIds: [] }),
) {
  return async (req: HttpRequestLike, res: HttpResponseLike): Promise<void> => {
    const method = (req as { method?: string }).method
    if (method !== 'POST') {
      writeJson(res, 405, { ok: false, error: 'method-not-allowed' })
      return
    }
    const webRuntime = ctx.get('webRuntime') as WebRuntimeLike | undefined
    if (!isTrustedApiRequest(req, webRuntime?.trustedHosts ?? [])) {
      writeJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    let body: ReflowPayload
    try {
      body = await readJsonBody(req) as ReflowPayload
    } catch {
      writeJson(res, 400, { ok: false, error: 'bad-request' })
      return
    }
    // 诊断读出口：`{"diag":true}` 取回最近请求与 agents 面状态（只读，不注入）。
    if ((body as { diag?: unknown }).diag === true) {
      writeJson(res, 200, { ok: true, recentClientPosts, ...diagnose() })
      return
    }
    const items = Array.isArray(body.items) ? body.items as ReflowItemPayload[] : []
    const valid = items.filter(item => typeof item.text === 'string' && item.text !== '')
    if (typeof body.parentSessionId !== 'string' || body.parentSessionId === '' || valid.length === 0) {
      recordPost({ at: Date.now(), sessionId: String(body.parentSessionId ?? ''), items: valid.length, outcome: 'bad-request' })
      writeJson(res, 400, { ok: false, error: 'bad-request: parentSessionId/items required' })
      return
    }
    const agent = resolveAgent(body.parentSessionId)
    if (agent === undefined || typeof agent.inject !== 'function') {
      recordPost({ at: Date.now(), sessionId: String(body.parentSessionId), items: valid.length, outcome: 'no-live-agent' })
      // 父会话无 live agent（未在屏/冷）——客户端回落搭车形态。
      // 一并回诊断：区分「服务没拿到」与「服务在但没有该 session」，
      // 否则只能反复猜（本问题已因此绕了 3 轮）。
      writeJson(res, 200, { ok: false, error: 'no-live-agent', diagnostics: diagnose() })
      return
    }
    // summary 收敛到官方上限（CONTEXT_SUMMARY_MAX_CHARS=120；审查 m3）。
    for (const item of valid) {
      const sideTitle = typeof item.sideTitle === 'string' ? item.sideTitle : ''
      const summary = (sideTitle === '' ? '侧边聊天的结论回流' : `来自「${sideTitle}」的结论回流`).slice(0, 120)
      try {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: item.text as string }],
          source: {
            kind: 'side-chat-reflow',
            plugin: 'dsh-sidenote',
            // form:'notice' + summary：折叠行直接显示回流摘要（不声明则 opaque
            // 渲染、折叠行只显示原始 plugin 串——审查 M2）。
            form: 'notice',
            summary,
          },
        }))
      } catch (error) {
        // agent 在 get 与 inject 之间被回收：本条注入失败，其余继续。
        console.warn('[dsh-sidenote] reflow 注入单条失败:', error)
      }
    }
    recordPost({ at: Date.now(), sessionId: String(body.parentSessionId), items: valid.length, outcome: 'injected' })
    writeJson(res, 200, { ok: true })
  }
}

export function apply(ctx: unknown): void {
  const host = ctx as HostContext

  // 服务一律走动态 inject（等服务）：cordis 的 ctx.get 对**未在 inject 清单里的
  // 服务不可达**。静态 get 探测拿到 undefined —— 本文件此前对 `agents` 就是这么
  // 失败的（恒 no-live-agent）。webServer / agents 在 headless 形态可能缺席，
  // inject 回调不触发即降级，不阻塞插件装载。
  const injectDyn = (host as {
    inject?: (
      deps: string[],
      cb: (injected: { get(name: string): unknown }) => void | (() => void),
    ) => unknown
  }).inject
  if (typeof injectDyn !== 'function') {
    console.warn('[dsh-sidenote] 宿主半包：ctx.inject 面缺席，reflow 路由未注册（客户端回落搭车）')
    return
  }

  // ① agents：注入的 scope 就是带该服务的子上下文，直接读 scope.agents。
  //    同时用它的 scope.on 记账作兜底（agents 服务缺席时仍能注已见过的 agent）。
  let agentsRef: AgentsLike | undefined
  let agentsInjected = false
  const registry: AgentRegistry = new Map()
  injectDyn.call(ctx, ['agents'], (scoped) => {
    agentsInjected = true
    const s = scoped as {
      agents?: AgentsLike
      on?: (event: string, listener: (payload: unknown) => void) => unknown
    } | undefined
    agentsRef = s?.agents
    console.log(
      `[dsh-sidenote] agents 面就绪：${agentsRef === undefined ? 'undefined' : 'ok'}（scope keys: ${
        s === undefined ? 'n/a' : Object.keys(s).slice(0, 12).join(',')
      }）`,
    )
    if (typeof s?.on !== 'function') return
    s.on('agent/created', (payload) => {
      const agent = (payload as { agent?: AgentLike } | undefined)?.agent
      const id = agent?.id
      if (agent === undefined || id === undefined || id === null) return
      registry.set(String(id), agent)
    })
    s.on('agent/disposed', (payload) => {
      const id = (payload as { agent?: AgentLike } | undefined)?.agent?.id
      if (id === undefined || id === null) return
      registry.delete(String(id))
    })
  })

  /** 两种 id 形式都试：带 `session-` 前缀的与裸 uuid。 */
  const lookupAgent = (
    service: AgentsLike | undefined,
    local: AgentRegistry,
    raw: string,
  ): AgentLike | undefined => {
    const PREFIX = 'session-'
    const keys = raw.startsWith(PREFIX) ? [raw, raw.slice(PREFIX.length)] : [raw, PREFIX + raw]
    for (const key of keys) {
      const hit = service?.get(key) ?? local.get(key)
      if (hit !== undefined) return hit
    }
    return undefined
  }

  // ② webServer：注册回流路由。
  injectDyn.call(ctx, ['webServer'], (injected) => {
    const webServer = injected.get('webServer') as WebServerLike | undefined
    if (webServer === undefined || typeof webServer.register !== 'function') return
    console.log('[dsh-sidenote] 宿主半包已装载，注册 /sidenote/reflow')
    return webServer.register({
      kind: 'exact',
      path: '/sidenote/reflow',
      // 优先官方 agents 服务，退到自记账。
      // ★ id 归一化：宿主 `Agent.id` 的字符串形式带 `session-` 前缀
      //   （`session-1eb57f48-…`），而客户端传的是**裸 uuid**。不归一化则
      //   lookup 恒 miss → 恒 no-live-agent。实测：带前缀 `{"ok":true}`，
      //   裸 uuid 仍 `no-live-agent`，且注入的 notice 真的进了会话。
      handler: makeReflowHandler(
        host,
        (raw) => lookupAgent(agentsRef, registry, raw),
        () => ({
          agentsInjected,
          agentsServiceSeen: agentsRef !== undefined,
          registryIds: [...registry.keys()],
        }),
      ),
    })
  })
}

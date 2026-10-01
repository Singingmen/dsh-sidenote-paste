/**
 * 归档让行桥（0.1.7 迁移）。
 *
 * ## 一、为什么需要 lift（解除归档）
 *
 * 0.1.7 新增宿主门禁 `ArchivedSessionGate`（`dsh-api-session-controller/lib/index.js`
 * L2422）在每一步之前检查 `agent/pre-step`，命中归档会话即 `{ kind: 'reject' }`：
 *
 *   ctx.on("agent/pre-step", (payload, next) =>
 *     underArchivedSession(ctx, payload.agent) ? Promise.resolve({ kind: "reject" }) : next())
 *
 * 官方注释同时给出解法（L2418-2420）："A late waking delivery to an archived
 * Session … proposes a step the gate rejects, which the loop ends as `blocked`
 * without a request; **unarchiving lifts the gate for the whole lineage.**"
 *
 * sidenote 的侧边会话正是「fork 后归档」的形态，于是用户发送的消息能进队列、
 * 能拿到本地回显，但宿主在 pre-step 直接拒绝，轮次以 blocked 结束、零模型
 * 请求 —— 用户视角「发送成功但永远没回答」。
 *
 * ## 二、签名陷阱（归档长期静默失效的根因）
 *
 * 客户端 `workspaces` 面的签名是 **`archiveSession(sessionId, options?)`** /
 * **`unarchiveSession(sessionId)`** —— 首参是**字符串**（见
 * `dsh-api-workspace-controller/lib/types/client/service.d.ts` L80/L87）；
 * 而宿主命令面才是 `archiveSession({ sessionId })` 对象形态。按对象传参会
 * 让请求发不出去，归档静默失效（会话在左侧列表堆积）。
 *
 * ## 三、生命周期（本模块的核心策略）
 *
 * 侧边会话的归档时机不能是「fork 后立刻」（门禁会拦住回复），也不能是
 * 「发送后」（没发送的会话永远不会被归档 → 左侧列表繁殖）。
 *
 *   fork 成功          → registerSideSession（记入 owned，但**保持未归档**
 *                        以便随时接收第一条消息）
 *   发送（submit）     → liftArchive（幂等；确保门禁放行）
 *   轮次结束 / 卸载    → restoreArchive（归档，除非轮次仍在飞）
 *
 * `owned` 是「本插件创建的侧边会话」集合，与 `lifted`（当前已解除归档）
 * 分离——这样**从未发送过消息的会话在关闭面板时同样会被归档**（此前的
 * 实现只归档发送过的，导致空会话永久残留在左侧列表，实测报告为
 * 「关闭后还有对话残余」）。
 */
import type { Context } from '../host/contracts.ts'

/** 客户端 workspaces 面的归档子集（首参为字符串——见文件头第二节）。 */
interface WorkspaceArchiveFace {
  unarchiveSession?: (sessionId: string) => Promise<unknown>
  archiveSession?: (sessionId: string, options?: { readonly stopActivity?: boolean }) => Promise<unknown>
}

/** 本插件创建的侧边会话（空闲时应处于归档态，以免占用左侧会话列表）。 */
const owned = new Set<string>()

/** 当前已解除归档的会话（轮次需要它们保持可见/可运行）。 */
const lifted = new Set<string>()

const archiveFaceOf = (ctx: Context): WorkspaceArchiveFace | undefined => {
  try {
    const workspaces = ctx.get('workspaces') as WorkspaceArchiveFace | undefined
    return workspaces ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 登记一个由本插件 fork 出来的侧边会话（fork 成功后立即调用）。
 * 登记本身**不改变归档状态**（会话保持未归档，以便随时接收第一条消息）；
 * 真正的归档发生在 `restoreArchive`（轮次结束或面板卸载）。
 * @param sessionId - fork 出的子会话 id。
 */
export function registerSideSession(sessionId: string): void {
  owned.add(sessionId)
}

/** 该会话是否由本插件创建（决定关闭面板时是否需要归档）。 */
export function isSideSession(sessionId: string): boolean {
  return owned.has(sessionId)
}

/**
 * 解除一个会话的归档（幂等），让宿主 ArchivedSessionGate 放行模型步。
 * @param ctx - 插件根 ctx（需要 workspaces 面）。
 * @param sessionId - 侧边（子）会话 id。
 * @returns true = 已发起解除（或此前已解除）。
 */
export function liftArchive(ctx: Context, sessionId: string): boolean {
  owned.add(sessionId)
  if (lifted.has(sessionId)) return true
  const workspaces = archiveFaceOf(ctx)
  if (workspaces?.unarchiveSession === undefined) return false
  lifted.add(sessionId)
  try {
    // 不 await：lift 是写前动作；失败时回滚标记以便下次重试（不阻塞发送）。
    void Promise.resolve(workspaces.unarchiveSession(sessionId)).catch(() => {
      lifted.delete(sessionId)
    })
    return true
  } catch {
    lifted.delete(sessionId)
    return false
  }
}

/**
 * 把一个空闲的侧边会话归档（会话列表卫生）。
 *
 * 对**本插件创建但从未发送过消息**的会话同样生效——这是「关闭面板后
 * 左侧列表残留」的修复点。轮次在飞时跳过（宿主会以 `workspace/session-active`
 * 拒绝，且归档会打断正在进行的回复）。
 *
 * @param ctx - 插件根 ctx。
 * @param sessionId - 侧边（子）会话 id。
 * @param options.running - 该会话当前是否在跑轮次（true 则跳过归档）。
 * @returns 是否真的发起了归档请求。
 */
export function restoreArchive(ctx: Context, sessionId: string, options?: { running?: boolean }): boolean {
  if (!owned.has(sessionId)) return false
  if (options?.running === true) return false
  const workspaces = archiveFaceOf(ctx)
  if (workspaces?.archiveSession === undefined) return false
  lifted.delete(sessionId)
  try {
    // 不传 stopActivity：轮次已结束或从未开始，无需停止活动（传了反而会
    // 打断刚提交但尚未起跑的排队消息）。
    void Promise.resolve(workspaces.archiveSession(sessionId)).catch(() => {
      // 归档失败：会话保持可见（refresh 后 sweep 会按布局判定清理记录）。
    })
    return true
  } catch {
    return false
  }
}

/** 插件卸载清场：把仍登记在册的侧边会话全部归档。 */
export function restoreAllArchives(ctx: Context): void {
  for (const sessionId of [...owned]) restoreArchive(ctx, sessionId)
}

/** 会话当前是否已解除归档（供 UI 判断「轮次中」）。 */
export function isArchiveLifted(sessionId: string): boolean {
  return lifted.has(sessionId)
}

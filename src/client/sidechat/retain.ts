/**
 * 侧边会话的 retain 桥（0.1.7 迁移）。
 *
 * 0.1.5 → 0.1.7 语义变化：`ctx.sessions.binding(id)` 由「按需物化」改为
 * **Borrow an already-retained binding without extending its lifetime**——
 * 只有被 retain 过的会话才有 live binding，否则恒返回 undefined。
 * fork 出来的子会话是「归档 + 从未 retain」的形态，故 binding 永远解析不到，
 * 面板相位卡在 loading（「正在准备侧边聊天…」卡死实证）。
 *
 * 本模块为插件自有的 retain 面：声明独立的 SessionReferenceSource 标签
 * （宿主类型是 declaration-merge-extensible 的），fork 后 retain 子会话，
 * 并把引用登记在模块级表里（tab 关闭/插件卸载时 release）。
 */
import type { Context } from '../host/contracts.ts'

/**
 * 本插件的 retain 来源标签。宿主 `SessionReferenceSourceMap` 是
 * declaration-merge-extensible 的，但插件未把 sessions 包列为依赖，故不做
 * 模块增强（TS2664）——改以字符串字面量传入，旧宿主无 retain 面时静默降级。
 */
const RETAIN_SOURCE = 'sideChat'

interface Retained {
  release(): void
}

/** 子会话 id → 引用（同一 id 只 retain 一次；重复 retain 会叠加计数）。 */
const retained = new Map<string, Retained>()

/**
 * 确保一个会话被 retain（幂等）。宿主面缺失时静默跳过（旧宿主无 retain）。
 * @param ctx - 插件根/面板 ctx。
 * @param sessionId - 目标会话。
 * @returns true = 已有（或本次建立）引用。
 */
export function ensureRetained(ctx: Context, sessionId: string): boolean {
  if (retained.has(sessionId)) return true
  try {
    // 经实例调用（不是解构后裸调）：retain 是原型方法，内部用 this 访问
    // scopes/retainObservers 等字段——脱离接收者会 TypeError。
    const sessions = ctx.sessions as unknown as {
      retain?: (target: string, options: { source: string }) => Retained
    }
    if (typeof sessions.retain !== 'function') return false
    const reference = sessions.retain(sessionId, { source: RETAIN_SOURCE })
    if (reference === undefined || reference === null) return false
    retained.set(sessionId, reference)
    return true
  } catch {
    // 旧宿主 / 未声明 source 的宿主：静默降级（binding 逻辑自行兜底）。
    return false
  }
}

/** 释放一个会话的引用（tab 关闭时调用；未 retain 过则 no-op）。 */
export function releaseRetained(sessionId: string): void {
  const reference = retained.get(sessionId)
  if (reference === undefined) return
  retained.delete(sessionId)
  try {
    reference.release()
  } catch {
    // 释放失败不影响面板。
  }
}

/** 插件卸载清场（apply 的 effect disposer 调用）。 */
export function releaseAllRetained(): void {
  for (const sessionId of [...retained.keys()]) releaseRetained(sessionId)
}

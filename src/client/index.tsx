/**
 * Client half of dsh-sidenote: the side-chat tabs (Workitem 01) and the
 * selection annotations (Workitem 02).
 *
 * 双模（Workitem_05）：betterSidebar 是 optional peer——
 * - 宿主 ≥ 0.1.5（有 sidebarRightTabs）：侧聊直连原生右栏（无论 BS 在不在）；
 * - 宿主 ≤ 0.1.2 + BS < 0.19：legacy 腿（betterSidebar 布局）。
 * betterSidebar 不在 inject 清单（required 会让无-BS 环境拒绝启动插件）；
 * 运行时经 directNativeLeg(ctx) 分腿，消费点全部判空。
 */
import type { Context } from './host/contracts.ts'
import { probeHost } from './host/probes.ts'
import { attachLocale, type LocaleServiceLike } from './locales.ts'
import { createReflowStore } from './reflow.ts'
import { registerSideChat } from './sidechat/index.tsx'
import { registerAnnotations } from './annotate/index.tsx'
import { clearNativeRuntime, setRootContext } from './sidechat/native.ts'
import { releaseAllRetained } from './sidechat/retain.ts'
import { readLiveTabIds, sweepOrphanedSideChatMeta } from './sidechat/metaStore.ts'

// `inputTriggers` 必须在列：侧边 composer 的斜杠/@ 菜单走
// `ctx.get('inputTriggers').sessionOf(actx)`，而 cordis 对**未 inject** 的
// 服务属性访问抛错、ctx.get 恒返回 undefined —— 缺它会让 /plan 这类命令
// 候选完全不出现（只能手打全名，实测报告为此症状）。
export const inject = ['sessions', 'workspaces', 'slots', 'connection', 'locale', 'inputTriggers']

export function apply(ctx: Context): void {
  // 侧栏 Tab 的原生面（better-sidebar >= 0.19）与宿主调用都要用插件根 ctx：
  // 面板拿到的是 slot 注入的收缩 ctx（inject 里没有 workspaces），见 native.ts。
  // fiber 撤销即清场（registry/openings/birthOrder 全模块级，重激活不得带病存活）。
  ctx.effect(() => {
    setRootContext(ctx)
    return () => {
      // 0.1.7：retain 的引用随 fiber 撤销一并释放（不留跨代际的会话占用）。
      releaseAllRetained()
      clearNativeRuntime()
    }
  }, 'dsh-sidenote: native bridge')
  // 跟随 DSH 通用设置里的语言（locale.preference，Host-backed，实时切换）。
  attachLocale(ctx.locale as LocaleServiceLike | undefined)
  // T2 off-face 全景探测：宿主升级后哪些能力降级了，开发者工具里一眼可见。
  probeHost(ctx)
  // 孤键清扫（对抗性审查 B2 的原意：清掉指向已消失 tab 的记录）。
  // 0.1.7 修正：判定改为**布局感知**——旧实现按 runId 判定，而 runId 每刷新
  // 必换，导致每次刷新误删带 childId 的活记录 → 面板读不到 childId → 重 fork
  // → 会话繁殖（实测 19 个孤儿会话）。这里传当前宿主布局里的 tab id 集合；
  // 拿不到布局面则传 undefined（sweep 自身 fail-open，一律不清）。
  sweepOrphanedSideChatMeta(readLiveTabIds())
  // 回流 store 两个模块共享：sidechat 生产（回流按钮），annotate 消费
  // （chip + 发送拦截器序列化）。
  const reflow = createReflowStore()
  registerSideChat(ctx, reflow)
  registerAnnotations(ctx, reflow)
}

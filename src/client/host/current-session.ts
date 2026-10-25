/**
 * 「当前主会话」身份的单一来源。
 *
 * DSH 0.2.x 的 `sessions.list` 快照里**没有 `current` 字段**（SessionListState 只有
 * `ids` / `byId` / `phase` / `projectionsBySession`）。旧实现读
 * `getSnapshot().current` 恒得 `undefined` → `currentSessionId()` 返回 '' →
 * 发送拦截器 `hijack()` 第一行就 return false，**注释与回流从来不随消息发出**
 * （2026-10-25 服务端实测：`client-report:#hijack-no-session`）。
 *
 * 权威来源是 composer dock 槽的 `props.session.sessionId` —— chip 一直用它，
 * 所以 chip 能显示、拦截器却查不到。这里把它记下来，供拦截器与注释控制器复用。
 */
export const currentMainSession: { id: string } = { id: '' }

/** 记下槽注入的当前主会话 id（幂等；空值忽略）。 */
export function noteMainSession(id: unknown): void {
  if (typeof id === 'string' && id !== '') currentMainSession.id = id
}

/** 读回：优先槽注入值。 */
export function readMainSession(): string {
  return currentMainSession.id
}

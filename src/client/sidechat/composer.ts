/**
 * 侧边聊天 composer 的状态层：优先复用会话 input 机器（草稿机），
 * 拿不到时整体降级为本地草稿 + session.prompt。
 *
 * 机器路径（dsh-better-sidebar src/client/conversation-draft.ts 同款惰性模式）：
 *   ctx.sessions.scope(childId) 取会话 scope ctx
 *   → ctx.get('conversation') 惰性取会话服务
 *   → conversation.input.for(actx) 取该会话的 SessionInput 草稿机
 *     （draft 读写 / submit / notify 全在这张脸上）。
 *
 * 已知风险（design.md 已标注的 spike 点）：InputHub 的 shell 由 sessions
 * provide materialization 触发创建，「从未 staged 的会话 scope」可能没有
 * resident shell —— 任何一步失败都降级，绝不崩面板。
 */
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import type { Context, ConversationService, SessionFace, SessionInput } from '../host/contracts.ts'
import { appendDraftText } from './model.ts'
import { attachFiles, resolveAttachmentApis } from './composer/attach.ts'
import { ensureRetained } from './retain.ts'
import { liftArchive } from './archive-gate.ts'

const NOOP_UNSUBSCRIBE = (): void => {}

/**
 * 解析 childId 会话的 input 草稿机；任何一步缺失/抛错返回 null
 * （调用方走降级路径）。
 *
 * 0.1.7：`ctx.sessions.scope(id)` 与 `binding(id)` 同属「只在已 retain 的
 * generation 上可用」的面（Borrow an already-retained Agent-scoped Context）。
 * 未 retain 时 scope 返回 undefined → input 机器解析失败 → 面板降级为
 * session.prompt 路径（发送看似成功但子会话未接管，用户视角「发送后没有
 * 回答」）。故此处先 ensure retain 再取 scope。
 */
export function resolveSessionInput(ctx: Context, childId: string): SessionInput | null {
  try {
    ensureRetained(ctx, childId)
    const actx = ctx.sessions.scope(childId)
    if (actx === undefined) return null
    const conversation = ctx.get('conversation') as ConversationService | undefined
    if (conversation === undefined || conversation === null) return null
    const input = conversation.input.for(actx)
    if (input === null || input === undefined) return null
    if (typeof input.setDraft !== 'function' || typeof input.submit !== 'function') return null
    if (input.state === undefined || typeof input.state.getSnapshot !== 'function') return null
    return input
  } catch {
    return null
  }
}

/** 读草稿机的当前草稿（容错）。 */
export function readInputDraft(input: SessionInput): string {
  try {
    const draft = input.state.getSnapshot().draft
    return typeof draft === 'string' ? draft : ''
  } catch {
    return ''
  }
}

/** composer 对外脸：machine 标记实际落点（true = input 机器，false = 自绘降级）。 */
export interface Composer {
  readonly machine: boolean
  readonly draft: string
  readonly sendError: string | null
  setDraft(text: string): void
  /** 拼接一段外部文本（桥接注入的引文草稿）。 */
  appendDraft(text: string): void
  /** 发送当前草稿（空草稿 no-op）。mode 缺省 = 机器/设置裁决（busy-Enter）。
   *  首条消息前缀由 useComposer 的 firstSendPrefix 选项注入（Delivery_04）。 */
  submit(mode?: 'queue' | 'steer'): void
  /** 斜杠/@ 触发接线需要：机器相位 + 草稿版本号（缺机器时 undefined）。 */
  readonly phase: string | undefined
  readonly draftRev: number | undefined
  /** 待发图片附件 id 列（附件 rail；缺机器时空）。 */
  readonly imageIds: readonly string[]
  /** 待发图片的预览（rail 渲染用；id + previewUrl）。 */
  readonly imagePreviews: readonly { id: string; url: string }[]
  /** 附件能力可用（机器在 + createDraftImages 面在）。 */
  readonly canAttach: boolean
  /** 选中文件挂为草稿图片；返回是否挂上。 */
  attachImages(files: readonly File[]): boolean
  /** 移除一张待发图片。 */
  removeImage(id: string): void
}

/**
 * 面板 composer hook。机器路径：草稿住在 input 机器的 store 里（随会话持久、
 * 与主输入框同语义），submit 走机器事务（序列化/裁决/默认 sink 全在机器内）。
 * 降级路径：草稿住本地 state，发送直连 session.prompt([...], 'queue')，
 * 失败时回填草稿并报错。
 *
 * firstSendPrefix（Delivery_04 busy fork）：首条消息发送瞬间现取的前缀块
 * （主线进展快照）。拼进即消费（由调用方清标记）——机器路径的失败回填与
 * 降级路径的重试都保留已拼文本，天然不会二次拼接。
 *
 * onSubmitText（Delivery_05 内容身份）：每次 submit 拿到干净 body（不含
 * 快照前缀），供面板捕获首条消息主题为 topic；是否首条的判定归调用方。
 */
export function useComposer(ctx: Context, session: SessionFace | undefined, childId: string | undefined, options?: { firstSendPrefix?: () => string | null, onSubmitText?: (body: string) => void }): Composer {
  // 0.1.7：input 机器的可用性不再「会话生命周期内不变」——它取决于
  // ctx.sessions.scope(childId) 能否解析，而该面只在子会话被 retain 后有
  // 值。首次渲染可能早于 retain 完成（fork 刚落 meta、面板先挂载），
  // 所以此处做成「会话列表/绑定状态变化时重试解析」的可恢复形态：
  // 用 list 快照的 revision 作为重试信号（retain 由 ensureRetained 幂等推进，
  // scope 一旦可解析，下一次渲染即拿到 input）。
  const listRev = useSyncExternalStore(
    useCallback((notify: () => void) => ctx.sessions.list.subscribe(notify), [ctx]),
    () => {
      const snap = ctx.sessions.list.getSnapshot()
      // 需要「会话列表已就绪」这一事实作为重试边界：就绪后 binding/scope 才可能有值。
      return snap.phase === 'ready' ? (snap.byId?.[childId ?? ''] !== undefined ? 2 : 1) : 0
    },
  )
  const input = useMemo(
    () => (childId === undefined ? null : resolveSessionInput(ctx, childId)),
    // listRev 参与依赖：子会话进列表（或列表就绪）后强制重解析一次。
    [ctx, childId, listRev],
  )

  const machineState = useSyncExternalStore(
    useCallback(
      (notify: () => void) => (input === null ? NOOP_UNSUBSCRIBE : input.state.subscribe(notify)),
      [input],
    ),
    () => (input === null ? null : input.state.getSnapshot()),
  )
  const machineDraft = machineState?.draft ?? ''
  const [localDraft, setLocalDraft] = useState('')
  const [sendError, setSendError] = useState<string | null>(null)

  const draft = input === null ? localDraft : machineDraft

  // 附件 API（off-face 探测；一次解析，会话生命周期内不变）。
  const apis = useMemo(() => resolveAttachmentApis(ctx), [ctx])

  const attachImages = useCallback(
    (files: readonly File[]): boolean => {
      if (input === null || apis === null || childId === undefined) return false
      return attachFiles(apis, input, childId, files)
    },
    [input, apis, childId],
  )

  const removeImage = useCallback(
    (id: string): void => {
      if (input === null || apis === null) return
      // 0.1.7：removeAttachment（旧名 removeImage 回退）。
      if (typeof input.removeAttachment === 'function') input.removeAttachment(id)
      else input.removeImage?.(id)
      apis.release(id)
    },
    [input, apis],
  )

  const setDraft = useCallback(
    (text: string): void => {
      if (input === null) setLocalDraft(text)
      else input.setDraft(text)
    },
    [input],
  )

  const appendDraft = useCallback(
    (text: string): void => {
      if (input === null) setLocalDraft(d => appendDraftText(d, text))
      else input.setDraft(appendDraftText(readInputDraft(input), text))
    },
    [input],
  )

  const submit = useCallback((mode?: 'queue' | 'steer'): void => {
    const body = draft.trim()
    if (body === '') return
    // 0.1.7：发送前解除归档。宿主 ArchivedSessionGate 会拒绝归档会话的每一次
    // agent/pre-step（轮次以 blocked 结束、零模型请求）——侧边会话若处于归档
    // 态，消息能进队、有本地回显，但永远等不到回答（实证）。轮次结束后由
    // SideChatPanel 的 running 翻转 effect 恢复归档（restoreArchive）。
    if (childId !== undefined) liftArchive(ctx, childId)
    // 内容身份钩子（Delivery_05）：拿到的是不含快照前缀的干净 body。
    options?.onSubmitText?.(body)
    // 首条消息前缀（busy fork 的进展快照）：发送瞬间现取现拼。
    const prefix = options?.firstSendPrefix?.() ?? null
    const text = prefix === null ? body : `${prefix}\n\n${body}`
    if (input !== null) {
      // 机器路径：草稿清空、发送失败回填、通知条全由机器/sink 负责。
      // mode 缺省交给机器按宿主设置裁决（busy-Enter 偏好在机器内）。
      // 拼了前缀先落机器草稿再交机器——回填/重试语义与未拼一致。
      if (prefix !== null) input.setDraft(text)
      input.submit(mode)
      return
    }
    if (session === undefined) return
    setLocalDraft('')
    setSendError(null)
    session.prompt([{ type: 'text', text }], mode ?? 'queue').then((result) => {
      // RpcResult 直接 ok 联合（无 .result 包装，镜像已收窄——见 contracts.ts）。
      if (result.ok === false) {
        // 仅在用户未另行输入时回填，不盖掉新草稿。
        setLocalDraft(d => (d === '' ? text : d))
        setSendError(result.error?.message ?? '发送失败')
      }
    }).catch((error: unknown) => {
      setLocalDraft(d => (d === '' ? text : d))
      setSendError(error instanceof Error ? error.message : '发送失败')
    })
  }, [draft, input, session, options, childId, ctx])

  return {
    machine: input !== null,
    draft,
    sendError,
    setDraft,
    appendDraft,
    submit,
    phase: machineState?.phase,
    draftRev: machineState?.draftRev,
    // 0.1.7：InputState 的字段名从 imageIds 改为 attachmentIds（旧名回退）。
    imageIds: attachmentIdsOf(machineState),
    imagePreviews: (() => {
      const ids = attachmentIdsOf(machineState)
      if (ids.length === 0 || apis === null) return []
      try {
        return apis.resolve(ids).map(i => ({ id: i.id, url: i.previewUrl ?? '' }))
      } catch {
        return []
      }
    })(),
    canAttach: input !== null && apis !== null,
    attachImages,
    removeImage,
  }
}

/** 读输入机器的待发附件 id 列表（0.1.7 attachmentIds 优先，旧名 imageIds 回退）。 */
function attachmentIdsOf(state: { attachmentIds?: readonly string[]; imageIds?: readonly string[] } | null | undefined): readonly string[] {
  if (state === null || state === undefined) return []
  if (Array.isArray(state.attachmentIds)) return state.attachmentIds
  if (Array.isArray(state.imageIds)) return state.imageIds
  return []
}

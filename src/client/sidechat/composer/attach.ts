/**
 * 附件（图片）通道（WI-02 + 0.1.7 迁移）。
 *
 * 原实现走 0.1.5 的 off-face 具体类方法（`createDraftImages` / `draftImages`
 * / `releaseDraftImage` + `input.addImages`）。0.1.7 把这些全部改名：
 *
 * | 0.1.5（旧）              | 0.1.7（本文件）                    |
 * |--------------------------|-----------------------------------|
 * | createDraftImages(files) | createDrafts(sessionId, files)    |
 * | draftImages(ids)         | resolveDraftAttachments(ids)      |
 * | releaseDraftImage(id)    | releaseDraftAttachment(id)        |
 * | input.addImages(ids)     | input.addAttachments(ids)         |
 *
 * 语义同时升级：createDrafts 需要 sessionId（Agent-scope 身份），返回的
 * `ComposerAttachment` 是 image/file 判别联合。探测按「新名优先、旧名回退」
 * 双档实现——面迁移不弃旧档；三件套缺一即返回 null（调用点不渲染附件入口，
 * 与原约定一致）。
 */
import type { Context, SessionInput } from '../../host/contracts.ts'

/** 附件描述符（新旧面共有的最小形状；previewUrl 供 rail 缩略图）。 */
export interface AttachmentDescriptor {
  id: string
  previewUrl?: string
}

/** 附件能力的运行时面（0.1.7 新名 + 0.1.5 旧名兼容）。 */
export interface AttachmentApis {
  create(sessionId: string, files: readonly File[]): readonly AttachmentDescriptor[]
  resolve(ids: readonly string[]): readonly AttachmentDescriptor[]
  release(id: string): void
}

/** 按新名优先、旧名回退解析附件 API（缺失返回 null → 调用点不渲染附件入口）。 */
export function resolveAttachmentApis(ctx: Context): AttachmentApis | null {
  let conv: Record<string, unknown> | undefined
  try {
    conv = ctx.get('conversation') as Record<string, unknown> | undefined
  } catch {
    return null
  }
  if (conv === undefined || conv === null) return null

  // `this` 必须绑回 conversation 实例：这些都是 ConversationController 的
  // 原型方法，内部读写 `this.draftAttachments` 等实例字段——解构后单独调用
  // 会得到 "Cannot read properties of undefined (reading 'draftAttachments')"
  // （实测抓到的原始报错）。故一律经 .call(conv, …) 转发。
  const fn = (name: string): ((...args: unknown[]) => unknown) | undefined => {
    const candidate = conv[name]
    return typeof candidate === 'function' ? (candidate as (...args: unknown[]) => unknown) : undefined
  }

  // 0.1.7：createDrafts(sessionId, files) / 0.1.5：createDraftImages(files)。
  const createDrafts = fn('createDrafts')
  const createDraftImages = fn('createDraftImages')
  const create = createDrafts !== undefined
    ? (sessionId: string, files: readonly File[]): readonly AttachmentDescriptor[] =>
        createDrafts.call(conv, sessionId, files) as readonly AttachmentDescriptor[]
    : createDraftImages !== undefined
      ? (_sessionId: string, files: readonly File[]): readonly AttachmentDescriptor[] =>
          createDraftImages.call(conv, files) as readonly AttachmentDescriptor[]
      : undefined

  const resolveDraftAttachments = fn('resolveDraftAttachments')
  const draftImages = fn('draftImages')
  const resolve = resolveDraftAttachments !== undefined
    ? (ids: readonly string[]): readonly AttachmentDescriptor[] =>
        resolveDraftAttachments.call(conv, ids) as readonly AttachmentDescriptor[]
    : draftImages !== undefined
      ? (ids: readonly string[]): readonly AttachmentDescriptor[] =>
          draftImages.call(conv, ids) as readonly AttachmentDescriptor[]
      : undefined

  const releaseDraftAttachment = fn('releaseDraftAttachment')
  const releaseDraftImage = fn('releaseDraftImage')
  const release = releaseDraftAttachment !== undefined
    ? (id: string): void => { releaseDraftAttachment.call(conv, id) }
    : releaseDraftImage !== undefined
      ? (id: string): void => { releaseDraftImage.call(conv, id) }
      : undefined

  if (create === undefined || resolve === undefined || release === undefined) return null
  return { create, resolve, release }
}

/** 选中文件 → 注册为草稿附件并挂进输入机器；返回是否成功挂上。 */
export function attachFiles(
  apis: AttachmentApis,
  input: SessionInput,
  sessionId: string,
  files: readonly File[],
): boolean {
  try {
    const attachments = apis.create(sessionId, files)
    if (attachments.length === 0) return false
    // 0.1.7：addAttachments（旧名 addImages 回退）。
    const target = input as unknown as {
      addAttachments?: (ids: readonly string[]) => boolean
      addImages?: (ids: readonly string[]) => boolean
    }
    const ids = attachments.map(a => a.id)
    if (typeof target.addAttachments === 'function') return target.addAttachments(ids)
    if (typeof target.addImages === 'function') return target.addImages(ids)
    return false
  } catch (error) {
    console.warn('[dsh-sidenote] 附件注册失败:', error)
    return false
  }
}

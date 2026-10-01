/**
 * 用户消息里的图片缩略图（0.1.7 补齐）。
 *
 * 主对话把消息里的 `ImageBlock.attachment` 交给附件插件（经
 * `conversation.message.images` 槽）渲染成缩略图 + 点击放大；侧边面板此前
 * 只取文本，图片被 `contentTextOf` 降级成一行「[图片]」占位——用户视角
 * 「发出去的图变成一行字，而主对话还能悬浮看大图」（实测报告）。
 *
 * 本组件走宿主的**会话授权图片面**取 URL：
 *   ctx.uiConversation.imageUrl(sessionId, attachment) → Promise<string>
 *   ctx.uiConversation.peekImageUrl(sessionId, attachment) → string | undefined（同步缓存）
 * 面缺席时退化为「[图片]」文本，绝不崩面板。
 */
import { useEffect, useState } from 'react'
import css from './sidechat.module.css'
import { t } from '../locales.ts'
import type { Context } from '../host/contracts.ts'

/**
 * 会话授权图片加载器（0.1.7 实证面）。
 *
 * 真实来源（`dsh-client-ui-chat/lib/client.js` 里 loadImage 的构造处）：
 *   loadImage: (attachment) => ctx.uiConversation.imageUrl(sessionId, attachment)
 *   loadImage.peek = (attachment) => ctx.uiConversation.peekImageUrl(sessionId, attachment)
 *
 * `ImageAttachmentRef.attachmentId` 是「opaque storage identifier; never a
 * filesystem path or bearer URL」（dsh-attachment 契约），所以只能经这个
 * 会话授权面换取可渲染 URL；`peekImageUrl` 是同步缓存读（可选，先出图）。
 *
 * @returns 加载器（带可选 peek），或 null（面缺席 → 调用点退化占位文本）。
 */
export type ImageLoader = ((attachment: unknown) => Promise<string>) & {
  peek?: (attachment: unknown) => string | undefined
}

export function resolveImageLoader(ctx: Context, sessionId: string | undefined): ImageLoader | null {
  if (sessionId === undefined) return null
  try {
    const face = ctx.get('uiConversation') as {
      imageUrl?: (sessionId: string, attachment: unknown) => Promise<string>
      peekImageUrl?: (sessionId: string, attachment: unknown) => string | undefined
    } | undefined
    if (face === undefined || face === null || typeof face.imageUrl !== 'function') return null
    const imageUrl = face.imageUrl.bind(face)
    const loader: ImageLoader = (attachment: unknown) => imageUrl(sessionId, attachment)
    if (typeof face.peekImageUrl === 'function') {
      const peek = face.peekImageUrl.bind(face)
      loader.peek = (attachment: unknown) => peek(sessionId, attachment)
    }
    return loader
  } catch {
    return null
  }
}

/** 单张缩略图：懒加载 URL，失败退化为占位文本。 */
function Thumbnail(props: { loader: ImageLoader | null, attachment: unknown }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (props.loader === null) { setFailed(true); return }
    let cancelled = false
    void props.loader(props.attachment).then((resolved) => {
      if (!cancelled) setUrl(resolved)
    }).catch(() => {
      if (!cancelled) setFailed(true)
    })
    return () => { cancelled = true }
  }, [props.loader, props.attachment])

  if (failed || (url === null && props.loader === null)) {
    return <span className={css.imageFallback}>{t('imagePlaceholder')}</span>
  }
  if (url === null) return <span className={css.imagePending} aria-hidden="true" />
  return (
    <a className={css.imageLink} href={url} target="_blank" rel="noreferrer" title={t('imagePlaceholder')}>
      <img className={css.imageThumb} src={url} alt={t('imagePlaceholder')} loading="lazy" />
    </a>
  )
}

/**
 * 一条用户消息的全部图片（按源顺序）。
 * @param props.images - ImageBlock.attachment 引用列表。
 * @param props.loader - resolveImageLoader 的返回值。
 */
export function MessageImages(props: {
  images: readonly unknown[]
  loader: ImageLoader | null
}) {
  if (props.images.length === 0) return null
  return (
    <div className={css.imageRail}>
      {props.images.map((attachment, index) => (
        <Thumbnail key={index} loader={props.loader} attachment={attachment} />
      ))}
    </div>
  )
}

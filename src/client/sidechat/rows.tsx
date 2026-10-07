/**
 * 侧边面板的消息行家族（L2 视图）：MessageList/MessageRow/ReflowButton/
 * EmptyState/StateScreen。自 SideChatPanel.tsx 拆出（WI-00 预算纪律：
 * 面板壳只留编排）。渲染规则：MessageRow 全族 memo（字段值比较器）。
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { DisclosureRow, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconBranchOutlineRegular, IconCheckOutlineRegular, IconCopyOutlineRegular, IconNewChatOutlineRegular, IconShareOutlineRegular } from '../host/icons.ts'
import type { ChatMessage } from '../chat/transcript.ts'
import { partitionInherited } from '../chat/transcript.ts'
import { ToolCard } from '../chat/ToolCard.tsx'
import { ReasoningRow } from '../chat/ReasoningRow.tsx'
import { FoldCard } from '../chat/FoldCard.tsx'
import type { FoldStore } from '../chat/viewState.ts'
import { flattenReflowContent, splitProtocolPrefix } from '../annotate/format.ts'
import { SNAPSHOT_BLOCK_MARK, splitSnapshotPrefix } from './snapshot.ts'
import { markdownTextProps } from '../host/markdown.ts'
import type { ReflowStore } from '../reflow.ts'
import { pairQuestions } from './model.ts'
import { MessageImages, type ImageLoader } from './message-images.tsx'
import { t } from '../locales.ts'
import { useLocaleTick } from '../locale-tick.ts'
import css from './sidechat.module.css'

/** 空状态：💬 类图标 + 标题 + fork 语义文案（形态规格）。 */
export function EmptyState() {
  useLocaleTick()
  return (
    <div className={css.empty}>
      <div className={css.emptyIcon}><IconNewChatOutlineRegular size={32} /></div>
      <div className={css.emptyTitle}>{t('emptyTitle')}</div>
      <div className={css.emptyText}>{t('emptyText')}</div>
    </div>
  )
}

/** 加载 / 错误整屏态（标题 + 可选详情 + 可选指引）。 */
export function StateScreen(props: { title: string; detail?: string; hint?: string }) {
  useLocaleTick()
  return (
    <div className={css.stateScreen}>
      <div className={css.emptyIcon}><IconNewChatOutlineRegular size={32} /></div>
      <div className={css.emptyTitle}>{props.title}</div>
      {props.detail !== undefined && props.detail !== '' && <div className={css.stateDetail}>{props.detail}</div>}
      {props.hint !== undefined && props.hint !== '' && <div className={css.emptyText}>{props.hint}</div>}
    </div>
  )
}

/**
 * 剥出首条侧边用户消息里的主线进展快照块（Delivery_04）：快照提升到继承卡
 * 区域渲染（SnapshotCard），气泡只留用户正文（零污染）。
 *
 * 实现已移至 `./snapshot.ts`（纯逻辑、无 React/宿主依赖，单测可直取）；
 * 此处按既有导入面转出，保持调用方与测试的引用稳定。
 */
export { splitSnapshotPrefix } from './snapshot.ts'

/** 主线进展快照卡：继承卡同族的可展开行（协议块原文，等宽换行）。 */
function SnapshotCard({ takenAt, text, fold }: { takenAt: string | null; text: string; fold: FoldStore }) {
  useLocaleTick()
  const rowKey = 'mainline-snapshot'
  const open = useSyncExternalStore((fn: () => void) => fold.subscribe(fn), () => fold.isOpen(rowKey))
  return (
    <div className={css.flowRow}>
      <DisclosureRow
        icon={<IconBranchOutlineRegular size={14} />}
        title={takenAt !== null ? t('snapshotLabelAt', { at: takenAt }) : t('snapshotLabel')}
        open={open}
        expandable
        expandOnRowClick
        previewChevron
        onToggle={() => { fold.toggle(rowKey) }}
      >
        <div className={css.snapshotBody}><pre className={css.snapshotText}>{text}</pre></div>
      </DisclosureRow>
    </div>
  )
}

export function MessageList({ messages, fold, boundarySeq, reflow, parentSessionId, sideTitle, onPromote, imageLoader }: {
  messages: readonly ChatMessage[]
  fold: FoldStore
  boundarySeq: number | undefined
  reflow: ReflowStore
  parentSessionId: string | undefined
  sideTitle: string
  onPromote: () => void
  /** 会话授权图片加载器（用户消息的缩略图用；缺席退化为占位文本）。 */
  imageLoader: ImageLoader | null
}) {
  const [reflowAllDone, setReflowAllDone] = useState(false)
  // 问答成对：每条 assistant 消息配对它在回答的用户提问（回流时带上）。
  const questions = useMemo(() => pairQuestions(messages), [messages])
  // D1：fork 继承区折叠为指示卡（默认折叠=密度默认态；展开态在同一张卡里，
  // 内容走同一套 MessageRow——材质同源）。继承区默认不挂载（长 fork 历史的
  // 性能护栏）。
  const { inherited, fresh } = useMemo(() => partitionInherited(messages, boundarySeq), [messages, boundarySeq])
  // Delivery_04：首条新鲜用户消息的快照前缀块 → 提升到继承卡区域，
  // 气泡只留用户正文。
  const snapshotInfo = useMemo(() => {
    const first = fresh.find(m => m.role === 'user')
    if (first === undefined) return null
    const split = splitSnapshotPrefix(first.text)
    return split === null ? null : { key: first.key, ...split }
  }, [fresh])
  // P2 选择性回流：挑选模式下逐条勾选，只把选中的问答对带回去。
  // 默认勾选全部可回流项（与「整段回流」等价起点，用户再取消不要的）。
  // 声明在 renderRow 之前——renderRow 的闭包要读它们。
  const [selectMode, setSelectMode] = useState(false)
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set<string>())
  // 可回流项（与「整段回流」同一判据：非空、非流式的 assistant 消息）。
  const reflowable = useMemo(
    () => messages.filter(m => m.role === 'assistant' && m.text !== '' && m.streaming !== true),
    [messages],
  )
  const togglePick = useCallback((key: string) => {
    setPicked(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const renderRow = (message: ChatMessage) => {
    const m = snapshotInfo !== null && message.key === snapshotInfo.key
      ? { ...message, text: snapshotInfo.rest }
      : message
    return (
      <MessageRow key={m.key} message={m} question={questions.get(m.key)} fold={fold} reflow={reflow} parentSessionId={parentSessionId} sideTitle={sideTitle} imageLoader={imageLoader} selectMode={selectMode} checked={picked.has(m.key)} onToggleCheck={togglePick} />
    )
  }
  // P1-4 密度管理：≥2 个可折叠项时出现「全部折叠/展开」开关（FoldCard/工具卡/
  // 思考块全部折叠态外置在 fold store，一键收敛长工具流）。
  const foldableKeys = useMemo(() => {
    const keys: string[] = []
    if (inherited.length > 0) keys.push('inherited')
    for (const m of messages) {
      if (m.card !== undefined) keys.push(m.key)
      if (m.reasoning !== undefined && m.reasoning !== '') keys.push(`${m.key}:thinking`)
    }
    return keys
  }, [messages, inherited.length])
  useSyncExternalStore(useCallback((fn: () => void) => fold.subscribe(fn), [fold]), () => fold.getSnapshot())
  const anyOpen = foldableKeys.some(k => fold.isOpen(k))

  const enterSelect = useCallback(() => {
    setPicked(new Set(reflowable.map(m => m.key)))
    setSelectMode(true)
    setReflowAllDone(false)
  }, [reflowable])

  return (
    <div className={css.transcript}>
      {(foldableKeys.length >= 2 || (parentSessionId !== undefined && messages.length > 0)) && (
        <div className={css.densityRow}>
          {parentSessionId !== undefined && messages.length > 0 && (
            <span className={css.actionGroup}>
              {selectMode ? (
                <>
                  <button
                    type="button"
                    className={css.densityToggle}
                    onClick={() => {
                      // 只带走勾选的问答对。
                      let added = 0
                      for (const m of reflowable) {
                        if (!picked.has(m.key)) continue
                        reflow.add(parentSessionId, sideTitle, m.text, questions.get(m.key))
                        added += 1
                      }
                      if (added > 0) {
                        setReflowAllDone(true)
                        setSelectMode(false)
                      }
                    }}
                  >
                    {reflowAllDone ? t('reflowSelectedDone') : t('reflowSelected', { n: picked.size })}
                  </button>
                  <button
                    type="button"
                    className={css.densityToggle}
                    onClick={() => { setPicked(new Set(reflowable.map(m => m.key))) }}
                  >
                    {t('reflowSelectAll')}
                  </button>
                  <button
                    type="button"
                    className={css.densityToggle}
                    onClick={() => { setPicked(new Set()) }}
                  >
                    {t('reflowSelectNone')}
                  </button>
                  <button
                    type="button"
                    className={css.densityToggle}
                    onClick={() => { setSelectMode(false) }}
                  >
                    {t('cancel')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className={css.densityToggle}
                    title={t('reflowAllTitle')}
                    onClick={() => {
                      // D4 整段带走：所有问答成对逐条入回流 store（受控对象，
                      // 主输入框 chip 可预览/逐条撤；骨架=问答对，禁全量快照回灌）。
                      let added = 0
                      for (const m of reflowable) {
                        reflow.add(parentSessionId, sideTitle, m.text, questions.get(m.key))
                        added += 1
                      }
                      if (added > 0) setReflowAllDone(true)
                    }}
                  >
                    {reflowAllDone ? t('reflowAllDone') : t('reflowAll')}
                  </button>
                  <button
                    type="button"
                    className={css.densityToggle}
                    title={t('reflowSelectTitle')}
                    onClick={enterSelect}
                  >
                    {t('reflowSelect')}
                  </button>
                  <button
                    type="button"
                    className={css.densityToggle}
                    title={t('promoteTitle')}
                    onClick={onPromote}
                  >
                    {t('promote')}
                  </button>
                </>
              )}
            </span>
          )}
          {foldableKeys.length >= 2 && (
            <button type="button" className={css.densityToggle} onClick={() => { fold.setAll(foldableKeys, !anyOpen) }}>
              {anyOpen ? t('collapseAll') : t('expandAll')}
            </button>
          )}
        </div>
      )}
      {inherited.length > 0 && (
        <FoldCard count={inherited.length} rowKey="inherited" fold={fold}>
          {inherited.map(renderRow)}
        </FoldCard>
      )}
      {snapshotInfo !== null && (
        <SnapshotCard takenAt={snapshotInfo.takenAt} text={snapshotInfo.snapshot} fold={fold} />
      )}
      {fresh.map(renderRow)}
    </div>
  )
}

/** 回流按钮（W04 v2）：把这条 assistant 结论收为主会话的受控回流对象
 *  （主 composer 上方出现「侧边回流」chip），发送时随拦截器序列化。
 *  问答成对：带上它回答的那条用户提问（question 缺省时只有 <答>）。 */
function ReflowButton({ reflow, parentSessionId, sideTitle, text, question }: {
  reflow: ReflowStore
  parentSessionId: string | undefined
  sideTitle: string
  text: string
  question?: string
}) {
  useLocaleTick()
  const [done, setDone] = useState(false)
  const timer = useRef(0)
  // 卸载清定时器（C2 P2-7）。
  useEffect(() => () => { window.clearTimeout(timer.current) }, [])
  if (parentSessionId === undefined) return null
  return (
    <button
      type="button"
      className={css.reflowButton}
      title={done ? t('reflowDone') : t('reflowToMain')}
      aria-label={t('reflowToMain')}
      onClick={() => {
        reflow.add(parentSessionId, sideTitle, text, question)
        setDone(true)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => { setDone(false) }, 1600)
      }}
    >
      {done ? <IconCheckOutlineRegular size={12} /> : <IconShareOutlineRegular size={12} />}
    </button>
  )
}

/**
 * 消息复制按钮（P2）：悬停行内出现，一键把该条消息的纯文本写进剪贴板。
 *
 * 面板此前没有任何复制入口（rows.tsx/SideChatPanel.tsx 里 `copy` 零命中），
 * 用户只能手动划选——长结论尤其难选全。
 *
 * 剪贴板降级链：`navigator.clipboard.writeText`（需安全上下文）→ 临时
 * textarea + `document.execCommand('copy')`（http/localhost 或权限被拒时
 * 仍可用）。两者都失败则静默（不弹错，不打断阅读）。
 */
function CopyButton({ text }: { text: string }) {
  useLocaleTick()
  const [done, setDone] = useState(false)
  const timer = useRef(0)
  useEffect(() => () => { window.clearTimeout(timer.current) }, [])
  if (text === '') return null
  return (
    <button
      type="button"
      className={css.copyButton}
      title={done ? t('copyMessageDone') : t('copyMessageTitle')}
      aria-label={t('copyMessageTitle')}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return
          setDone(true)
          window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => { setDone(false) }, 1600)
        })
      }}
    >
      {done ? <IconCheckOutlineRegular size={12} /> : <IconCopyOutlineRegular size={12} />}
    </button>
  )
}

/** 写剪贴板（带 execCommand 回退）；返回是否成功。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 权限被拒 / 非安全上下文 → 落回退路径。
  }
  try {
    const holder = document.createElement('textarea')
    holder.value = text
    holder.setAttribute('readonly', '')
    holder.style.position = 'fixed'
    holder.style.opacity = '0'
    document.body.appendChild(holder)
    holder.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(holder)
    return ok
  } catch {
    return false
  }
}

// MessageRow 全族 memo（C-5 性能纪律）：transcriptOf 每次快照重建消息对象
// （引用必变），比较器按字段值比；store 与回调引用稳定（fold/reflow 单例）。
// 流式增长时只重渲变化的行（长 fork 历史的帧成本随列表长度摊平）。
interface MessageRowProps {

  message: ChatMessage
  question?: string
  fold: FoldStore
  reflow: ReflowStore
  parentSessionId: string | undefined
  sideTitle: string
  /** 会话授权图片加载器（resolveImageLoader 的结果；缺席退化为占位文本）。 */
  imageLoader: ImageLoader | null
  /** 挑选模式开启时，assistant 行前显示勾选框（P2  selective reflow）。 */
  selectMode?: boolean
  /** 该行是否被勾选（selectMode 下有效）。 */
  checked?: boolean
  /** 勾选状态变更（selectMode 下有效）。 */
  onToggleCheck?: (key: string) => void
}

const MessageRow = memo(function MessageRow({ message, question, fold, reflow, parentSessionId, sideTitle, imageLoader, selectMode, checked, onToggleCheck }: MessageRowProps) {
  useLocaleTick()
  switch (message.role) {
    case 'user': {
      // 带协议前缀的消息（注释/回流）在自绘面板同样留痕渲染：
      // 标签 + 正文，协议区不进界面（与宿主气泡手术同语义）。
      const proto = splitProtocolPrefix(message.text)
      if (proto !== null) {
        return (
          <div className={css.userRow}>
            <div className={css.userBubble}>
              <span className={css.sentChipRow}>
                {proto.annotations.length > 0 && (
                  <span className={css.sentChip} title={proto.annotations.map(a => `${a.id}. 「${a.quote}」${a.note}`).join('\n')}>
                    {t('sentChipLabel', { n: proto.annotations.length })}
                  </span>
                )}
                {proto.reflows.length > 0 && (
                  <span className={css.sentChip} title={proto.reflows.map(r => `${r.source}: ${flattenReflowContent(r.content).slice(0, 200)}`).join('\n')}>
                    {t('reflowBubbleLabel')}
                  </span>
                )}
              </span>
              {message.text.slice(proto.length)}
            </div>
          </div>
        )
      }
      return (
        <div className={css.userRow}>
          <div className={css.userBubble}>
            {message.images !== undefined && message.images.length > 0 && (
              <MessageImages images={message.images} loader={imageLoader} />
            )}
            {message.text}
          </div>
          {message.text !== '' && (
            <div className={css.userActions}>
              <CopyButton text={message.text} />
            </div>
          )}
        </div>
      )
    }
    case 'assistant':
      return (
        <div className={css.assistantRow}>
          {selectMode === true && (
            <label className={css.selectBox} title={t('reflowSelectHint')}>
              <input
                type="checkbox"
                checked={checked === true}
                onChange={() => { onToggleCheck?.(message.key) }}
              />
            </label>
          )}
          {message.text !== '' && message.streaming !== true && (
            <div className={css.rowActions}>
              <CopyButton text={message.text} />
              <ReflowButton reflow={reflow} parentSessionId={parentSessionId} sideTitle={sideTitle} text={message.text} question={question} />
            </div>
          )}
          <div className={css.assistantBody}>
            {message.reasoning !== undefined && message.reasoning !== '' && (
              <ReasoningRow
                text={message.reasoning}
                rowKey={`${message.key}:thinking`}
                fold={fold}
                {...(message.streaming === true ? { streaming: true } : {})}
              />
            )}
            {message.text !== ''
              ? <MarkdownText {...markdownTextProps(message.text, message.streaming)} />
              : message.streaming === true && <div className={css.streamingHint}>{t('writing')}</div>}
            {message.interrupted === true && <div className={css.noticeRow}>{t('stopped')}</div>}
          </div>
        </div>
      )
    case 'tool':
      // WI-01：渲染意图在场 → 原生级工具卡（DisclosureRow 壳 + 同源叶子块，
      // 默认折叠）；缺省（老快照/无 view）回退纯文本卡。
      if (message.card !== undefined) {
        return (
          <ToolCard
            model={message.card}
            rowKey={message.key}
            fold={fold}
            {...(message.streaming === true ? { streaming: true } : {})}
            {...(message.isError === true ? { error: true } : {})}
          />
        )
      }
      return (
        <div className={css.toolCard}>
          <div className={css.toolHead}>
            {t('toolLabel')} · {message.toolName}
            {message.isError === true && <span className={css.toolError}>{t('failed')}</span>}
            {message.streaming === true && <span className={css.toolRunning}>{t('running')}</span>}
          </div>
          {message.text !== '' && <div className={css.toolBody}>{message.text}</div>}
        </div>
      )
    case 'error':
      return <div className={css.errorRow}>{message.text}</div>
    case 'notice':
      return <div className={css.noticeRow}>{message.text}</div>
  }
}, rowPropsEqual)

/** memo 比较器：transcriptOf 每次快照重建消息对象（引用必变），按字段值比。 */
function rowPropsEqual(prev: MessageRowProps, next: MessageRowProps): boolean {
  if (prev.fold !== next.fold || prev.reflow !== next.reflow) return false
  if (prev.parentSessionId !== next.parentSessionId || prev.sideTitle !== next.sideTitle) return false
  if (prev.question !== next.question) return false
  if (prev.selectMode !== next.selectMode || prev.checked !== next.checked) return false
  if (prev.imageLoader !== next.imageLoader || prev.onToggleCheck !== next.onToggleCheck) return false
  const a = prev.message
  const b = next.message
  return a === b || (
    a.key === b.key && a.role === b.role && a.text === b.text
    && a.reasoning === b.reasoning && a.streaming === b.streaming
    && a.isError === b.isError && a.interrupted === b.interrupted
    && a.toolName === b.toolName && a.card === b.card && a.seq === b.seq
    && a.images === b.images
  )
}

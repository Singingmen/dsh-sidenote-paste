/**
 * 图标单一来源（0.1.7 迁移 + 未来版本适配的唯一改动点）。
 *
 * ## 为什么需要它
 *
 * 0.1.5 → 0.1.7 的破坏性变更之一是 **primitives 图标 API 改名**：
 * 旧名带尺寸后缀（`IconNewChatOutline16` / `IconChevronDownOutline14`），
 * 新名统一为字重后缀（`IconNewChatOutlineRegular`）。旧名在 0.1.7 里
 * **全部 undefined** —— React 渲染 undefined 组件即 **#130 崩溃**，表现为
 * 整个侧边面板白屏（实测：23 个符号全命中）。
 *
 * 当初的修法是**在 14 个文件里原地改名**（73 处）。这能跑，但把「宿主 API
 * 版本差异」散进了整个代码库：将来图标名再变（0.2.0 已在 `next` 通道），
 * 又得全库搜一遍。
 *
 * 本文件把这件事收敛成**一处适配**（借鉴上游 dsh-sidenote 0.4.5 的
 * `src/client/host/icons.ts` 做法）：
 *
 * - **运行时双档解析**：优先取新名（字重后缀），取不到退回旧名（尺寸后缀），
 *   都没有则给一个渲染 `null` 的空组件 —— **任何版本组合都不会 #130**。
 * - **对外保持新名**：与调用点现有的 `...Regular` 符号名一致，故各调用点
 *   **只改 import 来源**，符号名与用法零改动（上游选择保留旧名，我们反过来
 *   保留新名 —— 因为本地 fork 已经把调用点改成新名并验证通过，不动它们
 *   才是最小回归面）。
 * - **未来 0.2.0 若再改名**：只改本文件第 3 个参数即可，调用点无感。
 *
 * ## 用法
 *
 * ```ts
 * // 图标从本文件取；非图标（DisclosureRow / Menu / MarkdownText / 各 Block）仍从
 * // '@deepseek-ai/dsh-client-ui-primitives' 取。
 * import { IconNewChatOutlineRegular } from '../host/icons.ts'
 * import { DisclosureRow, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
 * ```
 *
 * @module dsh-sidenote/host/icons
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComponentType } from 'react'

/** 图标组件的最小 props 面（primitives 的 IconProps 子集——只声明我们真正传的）。 */
interface IconProps {
  size?: number
  className?: string
}

type IconComponent = ComponentType<IconProps>

/** 一个图标都取不到时的兜底：渲染 null（绝不让 undefined 进 React 树 → 不会有 #130）。 */
const EmptyIcon: IconComponent = () => null

const iconExports = primitives as unknown as Readonly<Record<string, IconComponent | undefined>>

/**
 * 优先取新名（字重后缀），退回旧名（尺寸后缀），都没有则空组件。
 * @param modernName - 0.1.7+ 的字重命名导出。
 * @param legacyName - 0.1.5 的尺寸命名导出。
 * @returns 可安全渲染的图标组件。
 */
function icon(modernName: string, legacyName: string): IconComponent {
  return iconExports[modernName] ?? iconExports[legacyName] ?? EmptyIcon
}

// ── 24 个在用的图标（本 fork 的调用点全集）────────────────────────────────
// 每行第二个参数是 0.1.5 的旧名，仅作兼容回退；0.1.7 走第一个参数。

export const IconBranchOutlineRegular = icon('IconBranchOutlineRegular', 'IconBranchOutline16')
export const IconChecklistOutlineRegular = icon('IconChecklistOutlineRegular', 'IconChecklistOutline14')
export const IconCheckOutlineRegular = icon('IconCheckOutlineRegular', 'IconCheckOutline16')
export const IconChevronDownOutlineRegular = icon('IconChevronDownOutlineRegular', 'IconChevronDownOutline14')
export const IconCloseOutlineRegular = icon('IconCloseOutlineRegular', 'IconCloseOutline16')
export const IconCodeOutlineRegular = icon('IconCodeOutlineRegular', 'IconCodeOutline16')
export const IconCopyOutlineRegular = icon('IconCopyOutlineRegular', 'IconCopyOutline16')
export const IconCordisPluginOutlineRegular = icon('IconCordisPluginOutlineRegular', 'IconCordisPluginOutline14')
export const IconEditOutlineRegular = icon('IconEditOutlineRegular', 'IconEditOutline16')
export const IconGlobeOutlineRegular = icon('IconGlobeOutlineRegular', 'IconGlobeOutline14')
export const IconInspectOutlineRegular = icon('IconInspectOutlineRegular', 'IconInspectOutline12')
export const IconListPenOutlineRegular = icon('IconListPenOutlineRegular', 'IconListPenOutline16')
export const IconNewChatOutlineRegular = icon('IconNewChatOutlineRegular', 'IconNewChatOutline16')
export const IconPaperclipOutlineRegular = icon('IconPaperclipOutlineRegular', 'IconPaperclipOutline16')
export const IconPlayOutlineRegular = icon('IconPlayOutlineRegular', 'IconPlayOutline16')
export const IconQuestionOutlineRegular = icon('IconQuestionOutlineRegular', 'IconQuestionOutline14')
export const IconRightUpOutlineRegular = icon('IconRightUpOutlineRegular', 'IconRightUpOutline16')
export const IconSearchOutlineRegular = icon('IconSearchOutlineRegular', 'IconSearchOutline16')
export const IconSendOutlineRegular = icon('IconSendOutlineRegular', 'IconSendOutline16')
export const IconShareOutlineRegular = icon('IconShareOutlineRegular', 'IconShareOutline16')
export const IconStopFillRegular = icon('IconStopFillRegular', 'IconStopFill16')
export const IconThinkOutlineRegular = icon('IconThinkOutlineRegular', 'IconThinkOutline16')
export const IconTrashOutlineRegular = icon('IconTrashOutlineRegular', 'IconTrashOutline16')
export const IconWarningOutlineRegular = icon('IconWarningOutlineRegular', 'IconWarningOutline16')

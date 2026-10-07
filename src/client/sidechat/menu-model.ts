/**
 * 菜单呈现的**纯逻辑**（权限档位行 / 思考强度档位行）。
 *
 * 刻意与 `PermissionChip.tsx` / `ModelMenu.tsx` 分离：那两个模块引 `@deepseek-ai/
 * dsh-client-ui-primitives`（重依赖树），单测会**整文件加载失败**（ADR-0080 教训：
 * 纯函数不要与重依赖视图同文件，否则回归用例根本跑不到）。本模块只依赖词典。
 */
import type { PermissionCatalogFace, SessionModelsResult } from '../host/contracts.ts'
import { t } from '../locales.ts'

/** 已知档位 → 词典键（与 dsh-base bundle 的 `presets` 字典一一对应）。 */
const PRESET_LABELS: Readonly<Record<string, 'permReadOnly' | 'permWorkspaceWrite' | 'permFullAccess'>> = {
  'read-only': 'permReadOnly',
  'workspace-write': 'permWorkspaceWrite',
  'danger-full-access': 'permFullAccess',
}

/**
 * 兜底档位表（**仅在宿主未暴露档位清单时使用**）。
 *
 * 顺序 = 收紧 → 放宽，与宿主 `presets` 字典同款三档（dsh-base `cordis.patch.yml`
 * L253-262 实证）。此前实现只列了后两档，导致 `read-only` **功能存在却选不到**。
 */
export const FALLBACK_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const

/**
 * preset 机器值 → 展示名。
 *
 * 已知档位走词典（中英双语）；未知档位按宿主 `displayPermissionPreset` 同款规则
 * 从机器值推导 —— 宿主 `presets` 是**可由 config 自定义的字典**，词典不可能穷举，
 * 故未知档位**必须**有可读回退，不能显示空白。
 */
export function presetLabel(preset: string): string {
  const known = PRESET_LABELS[preset]
  if (known !== undefined) return t(known)
  return preset
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

/** 权限菜单的一行（value = `/permission <value>` 的实参）。 */
export interface PermissionRow {
  value: string
  label: string
}

/** 已知档位 id 集合（走本地词典，保证菜单内命名风格一致）。 */
const KNOWN_PRESET_IDS: ReadonlySet<string> = new Set(Object.keys(PRESET_LABELS))

/**
 * 权限菜单的行清单。
 *
 * 三源优先级：① 宿主目录 → ② 兜底表（老宿主）；③ 当前档位不在列表里（宿主
 * 自定义 / 派生的 `custom`）时**补一行只读展示**，否则「当前是什么」在 chip 上无解。
 *
 * ★ 展示名归一：宿主只对**显式写了 `name` 的档位**下发中文（如 `auto-approve` →
 * 「自动审批（Flash）」），未写 `name` 的落回**机器值**（`optionOf` 的
 * `spec.name ?? name`）——于是 `read-only` 会原样显示成 `read-only`。故：
 * 已知档位统一用本地词典，未知档位沿用宿主给的名字（不臆造）。
 */
export function permissionRows(
  catalog: PermissionCatalogFace | null,
  effective: string,
): PermissionRow[] {
  const rows: PermissionRow[] = catalog !== null
    ? catalog.options.map(o => ({ value: o.value, label: KNOWN_PRESET_IDS.has(o.value) ? presetLabel(o.value) : o.name }))
    : FALLBACK_PRESETS.map(id => ({ value: id, label: presetLabel(id) }))
  if (!rows.some(r => r.value === effective)) rows.push({ value: effective, label: presetLabel(effective) })
  return rows
}

/** 当前选中型号的 reasoning 元数据（无 reasoning 字段 / 找不到该型号 → undefined）。 */
export function reasoningOf(models: SessionModelsResult): {
  efforts: readonly { id: string; name: string }[]
  defaultEffort?: string
} | undefined {
  for (const group of models.groups) {
    if (group.id !== models.current.provider) continue
    for (const m of group.models) {
      if (m.id !== models.current.model) continue
      return m.reasoning
    }
  }
  return undefined
}

/**
 * 当前生效的思考强度档位 id（无则 undefined ⇒ 菜单显示"默认"语义）。
 *
 * 显式选择优先，否则回落到模型声明的 `defaultEffort` —— 与宿主
 * `effectiveEffort = current.reasoningEffort ?? reasoning.defaultEffort` 同款。
 */
export function effectiveEffortId(models: SessionModelsResult): string | undefined {
  const reasoning = reasoningOf(models)
  if (reasoning === undefined) return undefined
  return models.current.reasoningEffort ?? reasoning.defaultEffort
}

/** 思考强度档位行（模型未声明档位时返回空数组 ⇒ 该分组整段不出现）。 */
export function effortRows(models: SessionModelsResult): { id: string; label: string; selected: boolean }[] {
  const reasoning = reasoningOf(models)
  if (reasoning === undefined || reasoning.efforts.length === 0) return []
  const effective = effectiveEffortId(models)
  return reasoning.efforts.map(e => ({ id: e.id, label: e.name, selected: effective === e.id }))
}

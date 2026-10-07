/**
 * 权限 chip（WI-02，D2 定档 c：同权 + 常显）：显示子会话当前权限档位，
 * 点击弹 Menu 切换（原生同路径：`session.command('/permission <id>')`）。
 *
 * 数据：session.projections.faceOf('permissions')（off-face——缺席则 chip
 * 不渲染）。KnobState = {preset, sandbox, approval}，preset null = 组合默认。
 *
 * 档位清单：宿主 `remote.permissionPresets.catalog()`（懒加载，展开时拉一次）。
 * **不写死档位表** —— 宿主 `presets` 是可自定义字典（dsh-base 默认三档：
 * read-only / workspace-write / danger-full-access）；此前实现硬编码了后两档，
 * 把 `read-only` 漏掉了。行构建逻辑见 `menu-model.ts`（纯函数，可单测）。
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconChevronDownOutlineRegular, IconInspectOutlineRegular } from '../host/icons.ts'
import type { Context, PermissionCatalogFace, SessionFace } from '../host/contracts.ts'
import { listPermissionPresets } from './lifecycle.ts'
import { permissionRows, presetLabel, type PermissionRow } from './menu-model.ts'
import { t } from '../locales.ts'
import { useLocaleTick } from '../locale-tick.ts'
import css from './sidechat.module.css'

/** KnobState 镜像（dsh-permission-presets：preset/sandbox/approval 三旋钮）。 */
interface KnobState {
  preset?: string | null
  sandbox?: string | null
  approval?: string | null
}

export function PermissionChip(props: { ctx: Context; session: SessionFace | undefined }) {
  useLocaleTick()
  const [open, setOpen] = useState(false)
  // 宿主档位目录（懒加载：首次展开才拉；catalog 是宿主级 RPC）。
  const [catalog, setCatalog] = useState<PermissionCatalogFace | null>(null)

  // off-face 探测：projections 面缺席（老宿主）→ chip 不渲染。
  const face = useMemo(() => {
    const p = props.session as unknown as { projections?: { faceOf?: (key: string) => { subscribe(f: () => void): () => void; getSnapshot(): unknown } } } | undefined
    return typeof p?.projections?.faceOf === 'function' ? p.projections.faceOf('permissions') : undefined
  }, [props.session])

  const knob = useSyncExternalStore(
    (fn) => face?.subscribe(fn) ?? (() => {}),
    () => (face?.getSnapshot() as KnobState | undefined) ?? null,
  )

  // preset 缺省 = 组合默认（默认部署 = workspace-write + ask）。
  const effective = knob?.preset ?? 'workspace-write'
  const rows: PermissionRow[] = useMemo(() => permissionRows(catalog, effective), [catalog, effective])

  if (face === undefined || knob === null) return null

  const items: MenuEntry[] = rows.map(r => ({
    id: r.value,
    label: r.label + (r.value === effective ? ' ✓' : ''),
  }))

  return (
    <Menu
      open={open}
      side="top"
      portal
      compact
      anchor={
        <button
          type="button"
          className={css.modelSelect}
          title={t('permChipTitle')}
          onClick={() => {
            const next = !open
            setOpen(next)
            if (next && catalog === null) {
              void listPermissionPresets(props.ctx).then((c) => { if (c !== null) setCatalog(c) })
            }
          }}
        >
          <IconInspectOutlineRegular size={12} />
          <span>{presetLabel(effective)}</span>
          <IconChevronDownOutlineRegular size={12} />
        </button>
      }
      items={items}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        void props.session?.command(`/permission ${id}`).catch(() => {})
      }}
    />
  )
}

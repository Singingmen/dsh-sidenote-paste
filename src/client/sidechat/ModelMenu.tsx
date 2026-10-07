/**
 * 模型选择器（WI-02）：composer 脚部的模型 chip → 两级 Menu（provider 分组
 * 标签 + 型号行），其后追加**思考强度**分组（模型自带 `reasoning.efforts`）。
 * 数据面走 lifecycle.ts 的双版本链（0.1.5 的 remote.session.modelCatalog/
 * selectModel 优先，<= 0.1.2 的 connection.api.sessions 回退）；切的是子会话
 * 自己的选择，不回写主会话。
 *
 * 懒加载：首次打开才拉目录（catalog RPC 有成本）；切换后本地标签立即更新。
 *
 * 思考强度：档位由宿主随模型下发（`ModelCatalogModel.reasoning.efforts`，
 * authority: dsh-api-session-controller）。**只列当前模型声明了的档位** ——
 * 不预设全局档位表（各 provider 的档位集合不同，写死必错）。模型无 reasoning
 * 时该分组整段不出现。
 */
import { useState } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { IconCheckOutlineRegular, IconChevronDownOutlineRegular } from '../host/icons.ts'
import type { Context, SessionModelsResult } from '../host/contracts.ts'
import { listModels, switchModel } from './lifecycle.ts'
import { effortRows } from './menu-model.ts'
import { t } from '../locales.ts'
import { useLocaleTick } from '../locale-tick.ts'
import css from './sidechat.module.css'

export function ModelMenu(props: {
  ctx: Context
  sessionId: string
  /** 当前展示名（fork 同步后主会话模型 / 或用户已切换的）。 */
  modelName: string | null
  onSwitched: (name: string) => void
}) {
  useLocaleTick()
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<SessionModelsResult | null>(null)
  const [switching, setSwitching] = useState(false)

  const openMenu = (): void => {
    setOpen(true)
    if (models !== null) return
    void listModels(props.ctx, props.sessionId).then((m) => {
      if (m !== null) setModels(m)
    })
  }

  const items: MenuEntry[] = []
  if (models !== null) {
    // ★ 思考强度置顶：本机 provider 分组 + 型号可达 60 项，追加在末尾等于
    // 不可见（实测反馈"看不到思考强度"）。档位是当前型号的属性，放最前
    // 才能一眼看到；行构建见 menu-model.ts（纯函数，可单测）。
    const efforts = effortRows(models)
    if (efforts.length > 0) {
      items.push({ type: 'label', id: 'e:label', text: t('effortTitle') })
      for (const effort of efforts) {
        items.push({
          id: `e:${effort.id}`,
          label: effort.label,
          ...(effort.selected ? { icon: <IconCheckOutlineRegular size={12} /> } : {}),
        })
      }
    }
    for (const group of models.groups) {
      items.push({ type: 'label', id: `g:${group.id}`, text: group.name })
      for (const m of group.models) {
        const selected = models.current.provider === group.id && models.current.model === m.id
        items.push({
          id: `${group.id}/${m.id}`,
          label: m.name,
          ...(selected ? { icon: <IconCheckOutlineRegular size={12} /> } : {}),
        })
      }
    }
  }

  // chip 副标题：当前思考强度档位（官方同款 model + effort 同显）。
  // 目录未加载时为空 —— 不显示未确认的值。
  const effortNow = models === null
    ? null
    : effortRows(models).find(e => e.selected)?.label ?? null

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
          title={t('modelSwitchTitle')}
          onClick={() => { open ? setOpen(false) : openMenu() }}
        >
          <span>{t('modelLabel', { name: props.modelName ?? t('modelFollowsMain') })}{effortNow !== null ? ` · ${effortNow}` : ''}</span>
          <IconChevronDownOutlineRegular size={12} />
        </button>
      }
      items={items}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        // 思考强度行：只改 effort，provider/model 沿用当前（部分模型切换会重置
        // effort，故此处显式带上当前 provider/model）。
        if (id.startsWith('e:')) {
          const effortId = id.slice(2)
          if (models === null) return
          setOpen(false)
          setSwitching(true)
          void switchModel(props.ctx, props.sessionId, models.current.provider, models.current.model, effortId)
            .then((name) => {
              if (name === null) return
              props.onSwitched(name)
              // 本地镜像新 effort，避免再次打开菜单仍显示旧选中项。
              setModels({ ...models, current: { ...models.current, reasoningEffort: effortId } })
            })
            .finally(() => { setSwitching(false) })
          return
        }
        const slash = id.indexOf('/')
        if (slash === -1 || models === null) return
        const provider = id.slice(0, slash)
        const model = id.slice(slash + 1)
        setOpen(false)
        setSwitching(true)
        // 切模型时不带 effort：由宿主取该模型的 defaultEffort（官方同款行为）。
        void switchModel(props.ctx, props.sessionId, provider, model)
          .then((name) => { if (name !== null) props.onSwitched(name) })
          .finally(() => { setSwitching(false) })
      }}
    />
  )
}

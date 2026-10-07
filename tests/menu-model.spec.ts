/**
 * 权限档位 / 思考强度菜单行的单测（纯逻辑，随 `menu-model.ts` 而可直取）。
 *
 * 背景（本轮实测）：
 *  - `PermissionChip` 原先把档位写死为 `['workspace-write','danger-full-access']`，
 *    而宿主 dsh-base 的 `presets` 字典**本来就有第三档 `read-only`**
 *    (`cordis.patch.yml` L253-262) ⇒ **功能存在却选不到**。
 *  - `ModelMenu` 原先不呈现思考强度：本地契约漏声明 `ModelCatalogModel.reasoning`，
 *    而宿主实际随每个模型下发 `{ efforts, defaultEffort }`。
 */
import { describe, expect, it } from 'vitest'
import {
  FALLBACK_PRESETS,
  effectiveEffortId,
  effortRows,
  permissionRows,
  presetLabel,
} from '../src/client/sidechat/menu-model.ts'
import type { SessionModelsResult } from '../src/client/host/contracts.ts'

const catalog = (options: { value: string; name: string }[]) => ({ options })

const modelsWith = (
  reasoning: { efforts: { id: string; name: string }[]; defaultEffort?: string } | undefined,
  currentEffort?: string,
): SessionModelsResult => ({
  current: { provider: 'p1', model: 'm1', ...(currentEffort !== undefined ? { reasoningEffort: currentEffort } : {}) },
  routable: true,
  groups: [{
    id: 'p1',
    name: 'Provider 1',
    models: [{ id: 'm1', name: 'Model 1', ...(reasoning !== undefined ? { reasoning } : {}) }],
  }],
})

describe('permissionRows（权限档位行）', () => {
  it('★ 回归：兜底表含 read-only —— 此前硬编码只列两档把第三档漏掉', () => {
    const rows = permissionRows(null, 'workspace-write')
    expect(FALLBACK_PRESETS).toContain('read-only')
    expect(rows.map(r => r.value)).toEqual(['read-only', 'workspace-write', 'danger-full-access'])
  })

  it('宿主目录优先：已知档位走本地词典，未知档位沿用宿主名（不臆造）', () => {
    const rows = permissionRows(catalog([
      { value: 'read-only', name: 'read-only' },   // 宿主未写 name ⇒ 落回机器值
      { value: 'my-custom', name: 'My Custom' },   // 宿主自定义档位
    ]), 'read-only')
    expect(rows.map(r => r.value)).toEqual(['read-only', 'my-custom'])
    // 已知档位 → 本地词典（不显示裸机器值 read-only）
    expect(rows[0]?.label).not.toBe('read-only')
    // 未知档位 → 原样沿用宿主的展示名
    expect(rows[1]?.label).toBe('My Custom')
  })

  it('宿主下发中文名的档位（如 auto-approve）未知于词典 → 沿用宿主名', () => {
    const rows = permissionRows(catalog([
      { value: 'auto-approve', name: '自动审批（Flash）' },
    ]), 'auto-approve')
    expect(rows[0]?.label).toBe('自动审批（Flash）')
  })

  it('当前档位不在清单里 → 补一行，保证"当前是什么"可显示', () => {
    const rows = permissionRows(catalog([{ value: 'read-only', name: 'Read only' }]), 'custom')
    expect(rows.map(r => r.value)).toEqual(['read-only', 'custom'])
    expect(rows[1]?.label).toBe('Custom')
  })

  it('当前档位已在清单里 → 不重复追加', () => {
    const rows = permissionRows(catalog([{ value: 'read-only', name: 'Read only' }]), 'read-only')
    expect(rows).toHaveLength(1)
  })

  it('未知档位的可读回退：机器值连字符分词首字母大写（不显示空白）', () => {
    expect(presetLabel('danger-full-access')).not.toBe('')
    expect(presetLabel('some-unknown-tier')).toBe('Some Unknown Tier')
  })
})

describe('effortRows / effectiveEffortId（思考强度档位）', () => {
  const reasoning = {
    efforts: [
      { id: 'off', name: 'Off' },
      { id: 'low', name: 'Low' },
      { id: 'max', name: 'Max' },
    ],
    defaultEffort: 'low',
  }

  it('★ 列出模型声明的全部档位，并按 defaultEffort 标记选中', () => {
    const rows = effortRows(modelsWith(reasoning))
    expect(rows.map(r => r.id)).toEqual(['off', 'low', 'max'])
    expect(rows.filter(r => r.selected).map(r => r.id)).toEqual(['low'])
  })

  it('显式选择优先于 defaultEffort（与宿主 effectiveEffort 同款）', () => {
    const m = modelsWith(reasoning, 'max')
    expect(effectiveEffortId(m)).toBe('max')
    expect(effortRows(m).filter(r => r.selected).map(r => r.id)).toEqual(['max'])
  })

  it('模型未声明 reasoning → 空数组（该分组整段不出现，不伪造档位）', () => {
    expect(effortRows(modelsWith(undefined))).toEqual([])
    expect(effectiveEffortId(modelsWith(undefined))).toBeUndefined()
  })

  it('模型声明了空 efforts → 同样不出现', () => {
    expect(effortRows(modelsWith({ efforts: [] }))).toEqual([])
  })

  it('当前型号不在目录里（陈旧选择）→ 无档位，不崩', () => {
    const stale: SessionModelsResult = {
      current: { provider: 'gone', model: 'gone' },
      routable: true,
      groups: [{ id: 'p1', name: 'P', models: [{ id: 'm1', name: 'M' }] }],
    }
    expect(effortRows(stale)).toEqual([])
    expect(effectiveEffortId(stale)).toBeUndefined()
  })

  it('★ 真实配置形状：localreverseproxy/deepseek-flash 七档全出（依 cordis.patch.yml L93-106）', () => {
    // 该 provider 的 deepseek-flash 声明 reasoningEfforts =
    // { off:null, minimal, low, medium, high, xhigh, max } ⇒ pi-ai 的
    // getSupportedThinkingLevels 保留全部（已声明的 xhigh/max 亦保留）⇒ 7 档。
    const real: SessionModelsResult = {
      current: { provider: 'localreverseproxy', model: 'deepseek-flash', reasoningEffort: 'max' },
      routable: true,
      groups: [{
        id: 'localreverseproxy',
        name: 'localreverseproxy',
        models: [{
          id: 'deepseek-flash',
          name: 'deepseek-flash',
          reasoning: {
            efforts: [
              { id: 'off', name: 'Off' },
              { id: 'minimal', name: 'Minimal' },
              { id: 'low', name: 'Low' },
              { id: 'medium', name: 'Medium' },
              { id: 'high', name: 'High' },
              { id: 'xhigh', name: 'Xhigh' },
              { id: 'max', name: 'Max' },
            ],
            defaultEffort: 'max',
          },
        }],
      }],
    }
    const rows = effortRows(real)
    expect(rows.map(r => r.id)).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    expect(rows.filter(r => r.selected).map(r => r.id)).toEqual(['max'])
  })
})

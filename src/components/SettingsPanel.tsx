import { useEffect, useMemo, useState } from 'react';
import { MAX_SEATS, createAgent, type AgentInstance } from '../domain/agent';
import {
  BUILTIN_STATUSES,
  MAX_CUSTOM_STATES,
  validateCustomStatuses,
  type AttentionTier,
  type CustomStatusDef,
} from '../domain/status';
import { DEFAULT_DISPLAY_PROFILE } from '../config/display';
import {
  describePersistTarget,
  type PersistBackend,
} from '../config/persist';
import type { AppConfig, CharacterConfig } from '../config/types';
import {
  ADAPTER_LABELS,
  ADAPTER_TYPES_PRIORITY,
  isBuddyAdapterType,
  isFileBackedAdapterType,
} from '../adapters/registry';
import { STATUS_LABELS_ZH } from '../domain/status';

export interface SettingsPanelProps {
  open: boolean;
  config: AppConfig;
  onClose: () => void;
  onSave: (next: AppConfig) => Promise<PersistBackend | void>;
}

function emptyCharacter(id: string): CharacterConfig {
  return {
    id,
    name: id,
    portraitPath: `/characters/${id}/portrait.png`,
    actions: BUILTIN_STATUSES.map((s) => ({
      status: s,
      assetPath: `/characters/${id}/portrait.png`,
    })),
  };
}

export function SettingsPanel({
  open,
  config,
  onClose,
  onSave,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState<AppConfig>(config);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [editCharId, setEditCharId] = useState<string>('default');

  useEffect(() => {
    if (!open) return;
    setDraft(structuredClone(config));
    setError(null);
    setSavedNote(null);
    setEditCharId(config.characters[0]?.id ?? 'default');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- snapshot on open
  }, [open]);

  const character = useMemo(() => {
    return (
      draft.characters.find((c) => c.id === editCharId) ??
      draft.characters[0] ??
      emptyCharacter('default')
    );
  }, [draft.characters, editCharId]);

  if (!open) return null;

  const updateAgent = (id: string, patch: Partial<AgentInstance>) => {
    setDraft((d) => ({
      ...d,
      agents: d.agents.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  };

  const updateCharacter = (id: string, patch: Partial<CharacterConfig>) => {
    setDraft((d) => ({
      ...d,
      characters: d.characters.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    }));
  };

  const setActionPath = (status: string, assetPath: string) => {
    setDraft((d) => ({
      ...d,
      characters: d.characters.map((c) => {
        if (c.id !== character.id) return c;
        const actions = BUILTIN_STATUSES.map((s) => {
          const prev = c.actions.find((a) => a.status === s);
          if (s === status) return { status: s, assetPath };
          return (
            prev ?? {
              status: s,
              assetPath: `/characters/${c.id}/icon.png`,
            }
          );
        });
        return { ...c, actions };
      }),
    }));
  };

  const addCharacter = () => {
    const id = `char_${draft.characters.length + 1}`;
    const ch = emptyCharacter(id);
    ch.name = `角色 ${draft.characters.length + 1}`;
    setDraft((d) => ({ ...d, characters: [...d.characters, ch] }));
    setEditCharId(id);
  };

  const addAgent = () => {
    if (draft.agents.length >= MAX_SEATS) {
      setError(`最多 ${MAX_SEATS} 个坐席`);
      return;
    }
    const used = new Set(draft.agents.map((a) => a.seatIndex));
    let seat = 0;
    while (used.has(seat) && seat < MAX_SEATS) seat += 1;
    const agent = createAgent({
      name: `Agent ${draft.agents.length + 1}`,
      seatIndex: seat,
      characterId: character.id,
      adapterType: 'file',
      adapterConfig: {
        statusUrl: `/status/agent-${seat}.json`,
        pollIntervalMs: 1500,
      },
    });
    setDraft((d) => ({ ...d, agents: [...d.agents, agent] }));
    setError(null);
  };

  const removeAgent = (id: string) => {
    setDraft((d) => ({ ...d, agents: d.agents.filter((a) => a.id !== id) }));
  };

  const addCustomStatus = () => {
    if (draft.customStatuses.length >= MAX_CUSTOM_STATES) {
      setError(`最多 ${MAX_CUSTOM_STATES} 个自定义状态`);
      return;
    }
    const id = `custom_${draft.customStatuses.length + 1}`;
    setDraft((d) => ({
      ...d,
      customStatuses: [
        ...d.customStatuses,
        { id, label: id, attention: 'attention' as AttentionTier },
      ],
    }));
    setError(null);
  };

  const updateCustom = (index: number, patch: Partial<CustomStatusDef>) => {
    setDraft((d) => ({
      ...d,
      customStatuses: d.customStatuses.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    }));
  };

  const removeCustom = (index: number) => {
    setDraft((d) => ({
      ...d,
      customStatuses: d.customStatuses.filter((_, i) => i !== index),
    }));
  };

  const handleSave = async () => {
    setError(null);
    setSavedNote(null);
    try {
      validateCustomStatuses(draft.customStatuses);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (draft.agents.length === 0) {
      setError('至少保留一个 Agent');
      return;
    }
    setSaving(true);
    try {
      const backend = await onSave(draft);
      setSavedNote(backend ? `已保存（${backend}）` : '已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };


  return (
    <div
      className="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="settings-panel">
        <header className="settings-header">
          <div>
            <h2>设置 · 界面</h2>
            <p className="muted">
              用户只需配置状态图、坐席位置、颜色与背景。适配器已预置。·{' '}
              {describePersistTarget()}
            </p>
          </div>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="settings-body">
          {/* Agents — UI fields only */}
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>坐席 Agents</h3>
              <button type="button" className="btn tiny" onClick={addAgent}>
                + 添加
              </button>
            </div>
            <p className="muted settings-note">
              顺序用「坐席 #」；侧边用下方「坐席侧」。不支持自由拖动。
            </p>
            <div className="settings-agent-list">
              {draft.agents.map((a) => (
                <div key={a.id} className="settings-agent-row ui-row">
                  <label>
                    名称
                    <input
                      value={a.name}
                      onChange={(e) =>
                        updateAgent(a.id, { name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    角色
                    <select
                      value={a.characterId}
                      onChange={(e) =>
                        updateAgent(a.id, { characterId: e.target.value })
                      }
                    >
                      {draft.characters.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    坐席 #
                    <input
                      type="number"
                      min={0}
                      max={MAX_SEATS - 1}
                      value={a.seatIndex}
                      onChange={(e) =>
                        updateAgent(a.id, {
                          seatIndex: Number(e.target.value) || 0,
                        })
                      }
                    />
                  </label>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={a.enabled}
                      onChange={(e) =>
                        updateAgent(a.id, { enabled: e.target.checked })
                      }
                    />
                    启用
                  </label>
                  <button
                    type="button"
                    className="btn tiny"
                    onClick={() => setEditCharId(a.characterId)}
                    title="编辑该角色状态图"
                  >
                    编图
                  </button>
                  <button
                    type="button"
                    className="btn tiny danger"
                    onClick={() => removeAgent(a.id)}
                  >
                    删除
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* Background + seat side */}
          <section className="settings-section">
            <h3>背景 · 位置 · 超时</h3>
            <div className="settings-grid">
              <label>
                背景模式
                <select
                  value={draft.background.mode}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      background: {
                        ...d.background,
                        mode: e.target.value as 'color' | 'image',
                      },
                    }))
                  }
                >
                  <option value="color">纯色</option>
                  <option value="image">图片</option>
                </select>
              </label>
              <label>
                颜色
                <input
                  type="color"
                  value={draft.background.color ?? '#0f1419'}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      background: { ...d.background, color: e.target.value },
                    }))
                  }
                />
              </label>
              <label className="span-2">
                背景图路径 / URL
                <input
                  value={draft.background.imagePath ?? ''}
                  placeholder="/path/or/https://…"
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      background: {
                        ...d.background,
                        imagePath: e.target.value || undefined,
                      },
                    }))
                  }
                />
              </label>
              <label>
                坐席侧
                <select
                  value={draft.seatSide}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      seatSide: e.target.value as AppConfig['seatSide'],
                    }))
                  }
                >
                  <option value="bottom">底部</option>
                  <option value="left">左侧</option>
                  <option value="right">右侧</option>
                </select>
                <span className="settings-field-hint">
                  「左/右」指坐席条相对舞台的方位；间距自动均分剩余空间。
                </span>
              </label>
              <label>
                需介入最长展示（秒）
                <input
                  type="number"
                  min={5}
                  max={3600}
                  value={Math.round(draft.escalationTimeoutMs / 1000)}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      escalationTimeoutMs:
                        (Number(e.target.value) || 60) * 1000,
                    }))
                  }
                />
                <span className="settings-field-hint">
                  超时后只让出舞台，坐席仍保持高亮。
                </span>
              </label>
              <label>
                美色版上台动画概率 (%)
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={5}
                  value={draft.seStageChancePercent}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      seStageChancePercent: Math.min(
                        100,
                        Math.max(0, Number(e.target.value) || 0),
                      ),
                    }))
                  }
                />
                <span className="settings-field-hint">
                  每次上台抽一次；抽中就用 se.stage-motion.webm，素材缺失时自动回退普通版。
                </span>
              </label>
              <label>
                坐席卡宽 (px)
                <input
                  type="number"
                  min={64}
                  max={240}
                  value={draft.seatCardWidth}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      seatCardWidth: Number(e.target.value) || d.seatCardWidth,
                    }))
                  }
                />
                <span className="settings-field-hint">
                  副屏约 2048 宽时，过大卡宽会横向滚动；优先靠间距自动填满。
                </span>
              </label>
              <label>
                坐席条高 (px)
                <input
                  type="number"
                  min={120}
                  max={320}
                  value={draft.seatStripHeight}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      seatStripHeight:
                        Number(e.target.value) || d.seatStripHeight,
                    }))
                  }
                />
              </label>
            </div>
          </section>

          {/* Per-character status art */}
          <section className="settings-section">
            <div className="settings-section-head">
              <h3>状态图 · 角色库</h3>
              <button type="button" className="btn tiny" onClick={addCharacter}>
                + 新角色
              </button>
            </div>
            <p className="muted settings-note">
              每个 Agent 绑定一个角色；每个角色有各自的 6 态立绘路径（约 2:3）。
            </p>
            <div className="settings-char-picker">
              {draft.characters.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  className={`settings-char-chip${c.id === character.id ? ' active' : ''}`}
                  onClick={() => setEditCharId(c.id)}
                >
                  {c.name}
                </button>
              ))}
            </div>
            <div className="settings-grid">
              <label>
                角色名称
                <input
                  value={character.name}
                  onChange={(e) =>
                    updateCharacter(character.id, { name: e.target.value })
                  }
                />
              </label>
              <label>
                角色 ID
                <input value={character.id} disabled />
              </label>
              {BUILTIN_STATUSES.map((s) => {
                const path =
                  character.actions.find((a) => a.status === s)?.assetPath ??
                  '';
                return (
                  <label key={s} className="span-2">
                    {STATUS_LABELS_ZH[s]} ({s})
                    <input
                      value={path}
                      onChange={(e) => setActionPath(s, e.target.value)}
                    />
                  </label>
                );
              })}
            </div>
            <div className="settings-preview-row">
              {BUILTIN_STATUSES.map((s) => {
                const path =
                  character.actions.find((a) => a.status === s)?.assetPath ??
                  '';
                return path ? (
                  <img
                    key={s}
                    className="settings-preview-thumb"
                    src={path}
                    alt={s}
                    title={s}
                  />
                ) : null;
              })}
            </div>
          </section>

          {/* Advanced — adapters / custom / window size */}
          <details className="settings-section settings-advanced">
            <summary>高级（适配器 / 自定义状态 / 窗口尺寸）</summary>
            <p className="muted settings-note">
              日常使用不必改。默认 10 个 Agent 已接好 file/bridge 状态文件。
            </p>
            <div className="settings-agent-list">
              {draft.agents.map((a) => (
                <div key={a.id} className="settings-agent-row">
                  <label>
                    {a.name}
                    <select
                      value={a.adapterType}
                      onChange={(e) =>
                        updateAgent(a.id, { adapterType: e.target.value })
                      }
                    >
                      {ADAPTER_TYPES_PRIORITY.filter((t) => t !== 'mock').map((t) => (
                        <option key={t} value={t}>
                          {ADAPTER_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  {isBuddyAdapterType(a.adapterType) ? (
                    <>
                      <label>
                        baseUrl
                        <input
                          value={
                            typeof a.adapterConfig?.baseUrl === 'string'
                              ? a.adapterConfig.baseUrl
                              : ''
                          }
                          onChange={(e) =>
                            updateAgent(a.id, {
                              adapterConfig: {
                                ...a.adapterConfig,
                                baseUrl: e.target.value || undefined,
                              },
                            })
                          }
                        />
                      </label>
                      <label>
                        authToken
                        <input
                          type="password"
                          value={
                            typeof a.adapterConfig?.authToken === 'string'
                              ? a.adapterConfig.authToken
                              : ''
                          }
                          onChange={(e) =>
                            updateAgent(a.id, {
                              adapterConfig: {
                                ...a.adapterConfig,
                                authToken: e.target.value || undefined,
                              },
                            })
                          }
                        />
                      </label>
                    </>
                  ) : null}
                  {isFileBackedAdapterType(a.adapterType) ? (
                    <label>
                      statusUrl
                      <input
                        value={a.adapterConfig?.statusUrl ?? ''}
                        onChange={(e) =>
                          updateAgent(a.id, {
                            adapterConfig: {
                              ...a.adapterConfig,
                              statusUrl: e.target.value || undefined,
                            },
                          })
                        }
                      />
                    </label>
                  ) : null}
                </div>
              ))}
            </div>

            <div className="settings-grid" style={{ marginTop: '0.75rem' }}>
              <label>
                windowWidth
                <input
                  type="number"
                  value={draft.windowWidth}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      windowWidth: Number(e.target.value) || d.windowWidth,
                    }))
                  }
                />
              </label>
              <label>
                windowHeight
                <input
                  type="number"
                  value={draft.windowHeight}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      windowHeight: Number(e.target.value) || d.windowHeight,
                    }))
                  }
                />
              </label>
            </div>
            <p className="muted settings-note">
              默认画布 {DEFAULT_DISPLAY_PROFILE.windowWidth}×
              {DEFAULT_DISPLAY_PROFILE.windowHeight}
            </p>

            <div className="settings-section-head" style={{ marginTop: '0.75rem' }}>
              <h3>自定义状态</h3>
              <button
                type="button"
                className="btn tiny"
                onClick={addCustomStatus}
              >
                + 添加
              </button>
            </div>
            {draft.customStatuses.map((c, i) => (
              <div key={i} className="settings-agent-row">
                <label>
                  id
                  <input
                    value={c.id}
                    onChange={(e) => updateCustom(i, { id: e.target.value })}
                  />
                </label>
                <label>
                  label
                  <input
                    value={c.label}
                    onChange={(e) => updateCustom(i, { label: e.target.value })}
                  />
                </label>
                <label>
                  attention
                  <select
                    value={c.attention ?? 'attention'}
                    onChange={(e) =>
                      updateCustom(i, {
                        attention: e.target.value as AttentionTier,
                      })
                    }
                  >
                    <option value="attention">attention</option>
                    <option value="silent">silent</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn tiny danger"
                  onClick={() => removeCustom(i)}
                >
                  删除
                </button>
              </div>
            ))}
          </details>
        </div>

        <footer className="settings-footer">
          {error && <p className="settings-error">{error}</p>}
          {savedNote && <p className="settings-ok">{savedNote}</p>}
          <div className="settings-footer-actions">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving ? '保存中…' : '保存并应用'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

import { useState, type FormEvent } from 'react';
import {
  Check,
  Copy,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type { AudioEqPreset } from '../../../shared/types/audio-dsp';
import { SYSTEM_AUDIO_PRESETS } from '../../../shared/utils/audio-dsp';

export interface AudioLabPresetManagerProps {
  activePresetId: string | null;
  customPresets: AudioEqPreset[];
  accentHex: string;
  accentGlowRgb: string;
  onApplyPreset: (presetId: string) => void;
  onSaveNewPreset: (name: string) => void;
  onRenamePreset: (presetId: string, nextName: string) => void;
  onDuplicatePreset: (presetId: string) => void;
  onDeletePreset: (presetId: string) => void;
  onResetFlat: () => void;
}

export function AudioLabPresetManager({
  activePresetId,
  customPresets,
  accentHex,
  accentGlowRgb,
  onApplyPreset,
  onSaveNewPreset,
  onRenamePreset,
  onDuplicatePreset,
  onDeletePreset,
  onResetFlat,
}: AudioLabPresetManagerProps) {
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const handleCreateSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      return;
    }
    onSaveNewPreset(trimmed);
    setNewName('');
  };

  const commitRename = (presetId: string) => {
    const trimmed = renameDraft.trim();
    if (trimmed) {
      onRenamePreset(presetId, trimmed);
    }
    setRenamingId(null);
    setRenameDraft('');
  };

  return (
    <section
      data-testid="audio-lab-preset-manager"
      aria-label="Quản lý Preset Equalizer"
      className="rounded-[22px] border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-4 sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-[15px] font-semibold text-[var(--text-primary)]">
            Preset Hệ Thống & Tùy Chỉnh
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            7 preset tham chiếu mặc định được bảo vệ · Lưu, nhân bản, đổi tên hoặc xóa preset cá nhân offline
          </p>
        </div>

        <button
          type="button"
          data-testid="preset-manager-reset-flat-btn"
          onClick={onResetFlat}
          className="lp-btn-ghost inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[12px] font-medium text-[var(--text-primary)]"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>Reset Flat</span>
        </button>
      </div>

      {/* Save Current Curve as Custom Preset */}
      <form
        onSubmit={handleCreateSubmit}
        className="mt-4 flex flex-wrap items-center gap-2"
      >
        <input
          type="text"
          maxLength={48}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          data-testid="preset-new-name-input"
          placeholder="Đặt tên cho cấu hình hiện tại (ví dụ: Tai nghe IEM, Đêm khuya...)"
          aria-label="Tên preset mới"
          className="lp-surface-input h-9 min-w-[240px] flex-1 rounded-xl px-3.5 text-[13px] focus:outline-none"
        />
        <button
          type="submit"
          data-testid="preset-save-new-btn"
          disabled={newName.trim().length === 0}
          style={
            newName.trim().length > 0
              ? { backgroundColor: accentHex, color: 'var(--user-accent-on)' }
              : undefined
          }
          className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-4 text-[12.5px] font-semibold transition disabled:cursor-not-allowed disabled:bg-[var(--surface-hover)] disabled:text-[var(--text-muted)]"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Lưu Preset mới</span>
        </button>
      </form>

      {/* System Presets (Protected — Apply or Duplicate only) */}
      <div className="mt-5">
        <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
          Preset hệ thống ({SYSTEM_AUDIO_PRESETS.length})
        </h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {SYSTEM_AUDIO_PRESETS.map((preset) => {
            const active = activePresetId === preset.id;
            return (
              <div
                key={preset.id}
                data-testid={`preset-card-${preset.id}`}
                style={
                  active
                    ? {
                        borderColor: accentHex,
                        backgroundColor: `rgba(${accentGlowRgb}, 0.14)`,
                      }
                    : undefined
                }
                className={`group flex items-start justify-between gap-2 rounded-2xl border p-3 transition ${
                  active
                    ? ''
                    : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)]/45 hover:border-[var(--border-glass)] hover:bg-[var(--surface-hover)]/50'
                }`}
              >
                <button
                  type="button"
                  data-testid={`preset-apply-${preset.id}`}
                  onClick={() => onApplyPreset(preset.id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                      {preset.name}
                    </span>
                    <Lock
                      aria-label="Preset hệ thống được bảo vệ"
                      className="h-3 w-3 shrink-0 text-[var(--text-muted)]"
                    />
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-[var(--text-muted)]">
                    {preset.description}
                  </p>
                </button>

                <button
                  type="button"
                  data-testid={`preset-duplicate-${preset.id}`}
                  onClick={() => onDuplicatePreset(preset.id)}
                  title={`Nhân bản preset ${preset.name}`}
                  aria-label={`Nhân bản preset ${preset.name}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom User Presets */}
      <div className="mt-5">
        <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
          Preset của bạn ({customPresets.length})
        </h3>

        {customPresets.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-[var(--border-subtle)] px-4 py-3 text-[12.5px] text-[var(--text-muted)]">
            Chưa có preset tùy chỉnh nào. Điều chỉnh EQ phía trên rồi nhấn «Lưu Preset mới» hoặc nhân bản từ một preset hệ thống.
          </p>
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {customPresets.map((preset) => {
              const active = activePresetId === preset.id;
              const isRenaming = renamingId === preset.id;
              const isConfirmingDelete = confirmDeleteId === preset.id;

              return (
                <div
                  key={preset.id}
                  data-testid={`preset-card-${preset.id}`}
                  style={
                    active
                      ? {
                          borderColor: accentHex,
                          backgroundColor: `rgba(${accentGlowRgb}, 0.14)`,
                        }
                      : undefined
                  }
                  className={`flex flex-col justify-between gap-2 rounded-2xl border p-3 transition ${
                    active
                      ? ''
                      : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)]/45 hover:border-[var(--border-glass)]'
                  }`}
                >
                  {isRenaming ? (
                    <div className="flex items-center gap-1.5">
                      <input
                        type="text"
                        maxLength={48}
                        autoFocus
                        value={renameDraft}
                        data-testid={`preset-rename-input-${preset.id}`}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            commitRename(preset.id);
                          } else if (e.key === 'Escape') {
                            setRenamingId(null);
                          }
                        }}
                        className="lp-surface-input h-8 min-w-0 flex-1 rounded-lg px-2.5 text-[12.5px] focus:outline-none"
                      />
                      <button
                        type="button"
                        data-testid={`preset-rename-confirm-${preset.id}`}
                        onClick={() => commitRename(preset.id)}
                        aria-label="Lưu tên mới"
                        className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--surface-hover)] text-[var(--text-primary)]"
                      >
                        <Check className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setRenamingId(null)}
                        aria-label="Hủy đổi tên"
                        className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-hover)]"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <button
                        type="button"
                        data-testid={`preset-apply-${preset.id}`}
                        onClick={() => onApplyPreset(preset.id)}
                        className="min-w-0 flex-1 text-left"
                      >
                        <p className="truncate text-[13px] font-semibold text-[var(--text-primary)]">
                          {preset.name}
                        </p>
                        <p className="font-mono-tabular mt-0.5 text-[11px] text-[var(--text-muted)]">
                          {preset.mode === 'parametric' ? 'Parametric 8-Band' : 'Graphic 10-Band'} · Preamp{' '}
                          {preset.preampDb >= 0 ? `+${preset.preampDb}` : preset.preampDb} dB
                        </p>
                      </button>

                      <div className="flex shrink-0 items-center gap-0.5">
                        <button
                          type="button"
                          data-testid={`preset-rename-btn-${preset.id}`}
                          onClick={() => {
                            setConfirmDeleteId(null);
                            setRenamingId(preset.id);
                            setRenameDraft(preset.name);
                          }}
                          title="Đổi tên preset"
                          aria-label={`Đổi tên ${preset.name}`}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`preset-duplicate-${preset.id}`}
                          onClick={() => onDuplicatePreset(preset.id)}
                          title="Nhân bản preset"
                          aria-label={`Nhân bản ${preset.name}`}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          data-testid={`preset-delete-btn-${preset.id}`}
                          onClick={() => {
                            setRenamingId(null);
                            setConfirmDeleteId(
                              isConfirmingDelete ? null : preset.id,
                            );
                          }}
                          title="Xóa preset"
                          aria-label={`Xóa ${preset.name}`}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-rose-500/15 hover:text-rose-500 dark:hover:text-rose-300"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  )}

                  {isConfirmingDelete && (
                    <div className="flex items-center justify-between gap-2 border-t border-[var(--border-subtle)] pt-2 text-[11.5px]">
                      <span className="text-rose-600 dark:text-rose-300">
                        Xóa preset này?
                      </span>
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-lg px-2 py-1 text-[var(--text-secondary)] hover:bg-[var(--surface-hover)]"
                        >
                          Hủy
                        </button>
                        <button
                          type="button"
                          data-testid={`preset-delete-confirm-${preset.id}`}
                          onClick={() => {
                            setConfirmDeleteId(null);
                            onDeletePreset(preset.id);
                          }}
                          className="rounded-lg bg-rose-600 px-2.5 py-1 font-semibold text-white hover:bg-rose-500"
                        >
                          Xác nhận xóa
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

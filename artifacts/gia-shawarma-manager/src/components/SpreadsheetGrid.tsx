import { useCallback, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { FileDown, FileUp, Plus, Save, Search, Trash2, X } from 'lucide-react';
import { exportRowsToExcel } from '@/lib/export';
import { parseExcelFile, parseClipboard } from '@/lib/import';
import { type RowUpdater } from '@/lib/use-grid-sync';
import { sheetInputClass } from '@/lib/utils';

export type ColDef<T extends Record<string, unknown>> = {
  key: keyof T & string;
  label: string;
  type?: 'text' | 'number' | 'date' | 'time' | 'select';
  options?: { value: string; label: string }[];
  width?: string;
  readOnly?: boolean;
  min?: number;
  step?: number;
};

type GridRow = Record<string, unknown> & { _key: string; _selected?: boolean; id?: number };

type Props<T extends GridRow> = {
  columns: ColDef<T>[];
  rows: T[];
  onRowsChange: (rows: RowUpdater<T>) => void;
  onSave: () => void | Promise<void>;
  saving?: boolean;
  lang: 'id' | 'ar';
  t: (key: string) => string;
  exportFilename?: string;
  importMap?: (raw: Record<string, unknown>) => Partial<T>;
  minHeight?: string;
  /** Override primary action label (defaults to t('saveAll')). */
  saveLabel?: string;
  /** When true, show unsaved-changes hint instead of misleading pending count alone. */
  dirty?: boolean;
};

function cellDisplayValue(val: unknown, type?: ColDef<GridRow>['type']) {
  if (type === 'number') {
    if (val === '' || val == null) return '';
    return String(val);
  }
  return String(val ?? '');
}

function parseNumberInput(raw: string): number | '' {
  if (raw === '') return '';
  const n = Number(raw);
  return Number.isNaN(n) ? '' : n;
}

function cellSearchText<T extends GridRow>(row: T, col: ColDef<T>): string {
  const val = row[col.key];
  if (val === '' || val == null) return '';
  if (col.type === 'select' && col.options) {
    const opt = col.options.find((o) => o.value === String(val));
    return `${opt?.label ?? ''} ${val}`.trim();
  }
  return String(val);
}

function rowMatchesSearch<T extends GridRow>(row: T, columns: ColDef<T>[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return columns.some((col) => cellSearchText(row, col).toLowerCase().includes(q));
}

export function SpreadsheetGrid<T extends GridRow>({
  columns, rows, onRowsChange, onSave, saving, lang, t, exportFilename, importMap, minHeight = '420px', saveLabel, dirty,
}: Props<T>) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');

  const filteredRows = useMemo(() => {
    const q = search.trim();
    if (!q) return rows;
    return rows.filter((row) => rowMatchesSearch(row, columns, q));
  }, [rows, columns, search]);

  const patchRows = useCallback((patcher: (prev: T[]) => T[]) => {
    onRowsChange(patcher);
  }, [onRowsChange]);

  const updateCell = useCallback((rowKey: string, colKey: string, value: unknown) => {
    patchRows((prev) => prev.map((r) => (r._key === rowKey ? { ...r, [colKey]: value } : r)));
  }, [patchRows]);

  const toggleSelect = (rowKey: string) => {
    patchRows((prev) => prev.map((r) => (r._key === rowKey ? { ...r, _selected: !r._selected } : r)));
  };

  const addRows = (n = 10) => {
    const blank = Object.fromEntries(columns.map((c) => [c.key, c.type === 'number' ? '' : ''])) as Partial<T>;
    patchRows((prev) => [
      ...prev,
      ...Array.from({ length: n }, (_, i) => ({
        ...blank,
        _key: `new-${Date.now()}-${i}`,
        _selected: false,
      })) as T[],
    ]);
  };

  const deleteSelected = () => {
    patchRows((prev) => prev.filter((r) => !r._selected));
  };

  const handlePaste = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'v') return;
    const active = document.activeElement as HTMLInputElement | HTMLSelectElement | null;
    if (!active?.dataset?.row || !active?.dataset?.col) return;
    e.preventDefault();
    navigator.clipboard.readText().then((text) => {
      patchRows((prev) => {
        const grid = parseClipboard(text);
        if (!grid.length) return prev;
        const startRow = prev.findIndex((r) => r._key === active.dataset.row);
        const startCol = columns.findIndex((c) => c.key === active.dataset.col);
        if (startRow < 0 || startCol < 0) return prev;
        const next = [...prev];
        grid.forEach((line, ri) => {
          const idx = startRow + ri;
          if (idx >= next.length) {
            const blank = Object.fromEntries(columns.map((c) => [c.key, c.type === 'number' ? '' : '']));
            next.push({ ...blank, _key: `paste-${Date.now()}-${ri}`, _selected: false } as T);
          }
          line.forEach((val, ci) => {
            const col = columns[startCol + ci];
            if (!col || col.readOnly) return;
            const parsed = col.type === 'number' ? parseNumberInput(val) : val;
            (next[idx] as Record<string, unknown>)[col.key] = parsed;
          });
        });
        return next;
      });
    }).catch(() => {});
  };

  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !importMap) return;
    const raw = await parseExcelFile(file);
    const imported = raw.map((row, i) => ({
      ...importMap(row),
      _key: `imp-${Date.now()}-${i}`,
      _selected: false,
    })) as T[];
    patchRows((prev) => [...prev, ...imported]);
    e.target.value = '';
  };

  const exportRows = rows.map((r) => {
    const out: Record<string, string | number> = {};
    columns.forEach((c) => { out[c.label] = (r[c.key] as string | number) ?? ''; });
    return out;
  });

  const pending = rows.filter((r) => {
    return columns.some((c) => {
      const v = r[c.key];
      return v !== '' && v !== 0 && v != null;
    });
  }).length;

  const searchLabel = t('searchResults')
    .replace('{n}', String(filteredRows.length))
    .replace('{total}', String(rows.length));

  return (
    <div className="panel soft-shadow overflow-hidden" onKeyDown={handlePaste}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[hsl(var(--border))] bg-[hsl(var(--muted)/.35)] px-4 py-3">
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-[hsl(var(--muted-foreground))] ltr:left-3 rtl:right-3" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('searchInTable')}
            className="w-full rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] py-2 text-xs font-medium outline-none focus:border-[hsl(var(--primary))] focus:ring-2 focus:ring-[hsl(var(--primary)/.12)] ltr:pl-9 ltr:pr-8 rtl:pl-8 rtl:pr-9"
            dir={lang === 'ar' ? 'rtl' : 'ltr'}
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch('')}
              className="absolute top-1/2 -translate-y-1/2 rounded p-0.5 text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] ltr:right-2 rtl:left-2"
              title={t('clearSearch')}
            >
              <X size={14} />
            </button>
          )}
        </div>
        {search.trim() && (
          <span className="text-[11px] font-semibold text-[hsl(var(--primary))]">{searchLabel}</span>
        )}
        <button type="button" onClick={() => addRows(10)} className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
          <Plus size={14} />{t('addRows')}
        </button>
        <button type="button" onClick={deleteSelected} className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold text-[hsl(var(--destructive))] hover:bg-red-50">
          <Trash2 size={14} />{t('deleteSelected')}
        </button>
        {importMap && (
          <>
            <button type="button" onClick={() => fileRef.current?.click()} className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
              <FileUp size={14} />{t('importExcel')}
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={handleImport} />
          </>
        )}
        {exportFilename && exportRows.length > 0 && (
          <button type="button" onClick={() => exportRowsToExcel(exportRows, exportFilename)} className="flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] px-3 py-2 text-xs font-bold hover:bg-[hsl(var(--muted))]">
            <FileDown size={14} />{t('exportExcel')}
          </button>
        )}
        <span className="text-[11px] text-[hsl(var(--muted-foreground))]">
          {dirty ? t('unsavedChanges') : `${pending} ${t('rowsPending')}`}
        </span>
        <span className="hidden text-[11px] text-[hsl(var(--muted-foreground))] sm:inline">· {t('pasteHint')}</span>
        <button type="button" disabled={saving} onClick={() => void onSave()} className="btn-primary ml-auto flex items-center gap-1.5 rounded-xl px-4 py-2 text-xs font-bold disabled:opacity-60">
          <Save size={14} />{saving ? '...' : (saveLabel ?? t('saveAll'))}
        </button>
      </div>
      <div className="mobile-scroll" style={{ maxHeight: minHeight, overflow: 'auto' }}>
        <table
          className="sheet-grid w-full min-w-[960px] border-collapse text-sm"
          dir={lang === 'ar' ? 'rtl' : 'ltr'}
          style={{ tableLayout: 'fixed' }}
        >
          <thead className="sticky top-0 z-10 bg-[hsl(var(--muted))] text-[11px] font-bold text-[hsl(var(--muted-foreground))]">
            <tr>
              <th className="w-11 border-b border-[hsl(var(--border))] px-2 py-3 text-center"><span className="sr-only">{t('selectRows')}</span></th>
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={`border-b border-[hsl(var(--border))] px-3 py-3 font-bold whitespace-nowrap ${col.type === 'number' ? 'text-start' : 'text-start'}`}
                  style={{ width: col.width || '110px' }}
                >
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.length ? filteredRows.map((row) => (
              <tr key={row._key} className={`border-b border-[hsl(var(--border)/.6)] ${row._selected ? 'bg-[hsl(var(--secondary)/.45)]' : 'hover:bg-[hsl(var(--muted)/.25)]'}`}>
                <td className="w-11 px-2 py-0 text-center align-middle">
                  <input type="checkbox" checked={!!row._selected} onChange={() => toggleSelect(row._key)} className="rounded" />
                </td>
                {columns.map((col) => {
                  const val = row[col.key];
                  if (col.readOnly) {
                    return <td key={col.key} className="px-3 py-2 text-xs align-middle text-[hsl(var(--muted-foreground))]">{String(val ?? '—')}</td>;
                  }
                  if (col.type === 'select' && col.options) {
                    return (
                      <td key={col.key} className="p-0 align-middle">
                        <select
                          data-row={row._key}
                          data-col={col.key}
                          value={String(val ?? '')}
                          onChange={(e) => updateCell(row._key, col.key, e.target.value)}
                          className={`${sheetInputClass} h-10 cursor-pointer`}
                          dir={lang === 'ar' ? 'rtl' : 'ltr'}
                        >
                          {col.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </td>
                    );
                  }
                  const isNum = col.type === 'number';
                  return (
                    <td key={col.key} className="p-0 align-middle">
                      <input
                        data-row={row._key}
                        data-col={col.key}
                        type={isNum ? 'text' : col.type === 'date' ? 'date' : col.type === 'time' ? 'time' : 'text'}
                        inputMode={isNum ? 'decimal' : undefined}
                        value={cellDisplayValue(val, col.type)}
                        min={col.min}
                        step={col.step}
                        onChange={(e) => {
                          const v = isNum
                            ? parseNumberInput(e.target.value)
                            : e.target.value;
                          updateCell(row._key, col.key, v);
                        }}
                        className={`${sheetInputClass} h-10 ${isNum ? 'font-mono tabular-nums' : ''}`}
                        dir={isNum || col.type === 'date' || col.type === 'time' ? 'ltr' : (lang === 'ar' ? 'rtl' : 'ltr')}
                        style={isNum ? { textAlign: lang === 'ar' ? 'right' : 'left' } : undefined}
                      />
                    </td>
                  );
                })}
              </tr>
            )) : (
              <tr>
                <td colSpan={columns.length + 1} className="px-4 py-10 text-center text-sm text-[hsl(var(--muted-foreground))]">
                  {t('noSearchResults')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function makeRowKey() {
  return `r-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

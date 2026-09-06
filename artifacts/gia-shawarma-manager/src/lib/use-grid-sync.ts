import { useEffect, useRef, useState } from 'react';

/** Keeps grid rows editable — only re-syncs from server when not dirty. */
export function useGridSync<T extends { _key: string }>(
  syncKey: string | number,
  isReady: boolean,
  buildRows: () => T[],
) {
  const [rows, setRows] = useState<T[]>([]);
  const dirtyRef = useRef(false);
  const lastSyncRef = useRef<string | number | null>(null);

  const buildRef = useRef(buildRows);
  buildRef.current = buildRows;

  useEffect(() => {
    if (!isReady) return;
    if (lastSyncRef.current !== syncKey) {
      lastSyncRef.current = syncKey;
      dirtyRef.current = false;
      setRows(buildRef.current());
      return;
    }
    if (dirtyRef.current) return;
    setRows(buildRef.current());
  }, [syncKey, isReady]);

  const markDirty = () => { dirtyRef.current = true; };
  const markClean = () => { dirtyRef.current = false; };

  return { rows, setRows, markDirty, markClean, dirtyRef };
}

export type RowUpdater<T> = T[] | ((prev: T[]) => T[]);

export function resolveRows<T>(prev: T[], next: RowUpdater<T>): T[] {
  return typeof next === 'function' ? next(prev) : next;
}

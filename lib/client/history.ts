// Stores finished checks locally in the browser (IndexedDB), never on a server.

import type { Range } from "../compare.ts";
import type { CheckResult } from "./runCheck.ts";

export interface UserAdjustments {
  ignoredRanges: Range[];
  citedRanges: Range[];
  ignoredSources: string[];
  citedSources: string[];
}

export const EMPTY_ADJUSTMENTS: UserAdjustments = { ignoredRanges: [], citedRanges: [], ignoredSources: [], citedSources: [] };

export interface HistoryEntry {
  id: string;
  date: string;
  title: string;
  words: number;
  percent: number;
  result: CheckResult;
  adjustments: UserAdjustments;
}

export type HistorySummary = Omit<HistoryEntry, "result" | "adjustments">;

const DB = "plagiatspruefer";
const STORE = "checks";
const MAX_ENTRIES = 25;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).finally(() => db.close());
}

export async function listHistory(): Promise<HistorySummary[]> {
  try {
    const all = await tx<HistoryEntry[]>("readonly", (s) => s.getAll() as IDBRequest<HistoryEntry[]>);
    return all
      .map(({ id, date, title, words, percent }) => ({ id, date, title, words, percent }))
      .sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

export async function loadEntry(id: string): Promise<HistoryEntry | null> {
  try {
    return (await tx<HistoryEntry | undefined>("readonly", (s) => s.get(id) as IDBRequest<HistoryEntry | undefined>)) ?? null;
  } catch {
    return null;
  }
}

export async function saveEntry(entry: HistoryEntry): Promise<void> {
  try {
    await tx("readwrite", (s) => s.put(entry));
    const all = await listHistory();
    for (const old of all.slice(MAX_ENTRIES)) await deleteEntry(old.id);
  } catch {
    /* storage unavailable (private mode, quota) – history is optional */
  }
}

export async function deleteEntry(id: string): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete(id));
  } catch {
    /* ignore */
  }
}

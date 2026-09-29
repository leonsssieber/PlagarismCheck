import type { ReactNode } from "react";
import type { SegmentKind } from "@/lib/compare";
import { tokenize } from "@/lib/text";

export const KIND_LABEL: Record<SegmentKind, string> = {
  exact: "Wörtlich übernommen",
  near: "Leicht verändert",
  paraphrase: "Paraphrase (umformuliert)",
  citation: "Zitat / korrekt zitiert",
  excluded: "Nicht geprüft",
};

export function hueFor(idx: number): number {
  return Math.round((idx * 137.508 + 210) % 360);
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Renders a string and emphasises words contained in `words`. */
export function emphasise(str: string, words: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let pos = 0;
  let key = 0;
  for (const t of tokenize(str)) {
    if (!words.has(t.w)) continue;
    if (t.s > pos) out.push(str.slice(pos, t.s));
    out.push(<b key={key++}>{str.slice(t.s, t.e)}</b>);
    pos = t.e;
  }
  if (pos < str.length) out.push(str.slice(pos));
  return out;
}

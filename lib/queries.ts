// Picks distinctive word sequences of the text to be used as search queries.

import type { PreparedDoc } from "./compare.ts";

export type Depth = "quick" | "standard" | "thorough";

export const DEPTH_SETTINGS: Record<Depth, { queries: number; sources: number; label: string }> = {
  quick: { queries: 8, sources: 10, label: "Schnell" },
  standard: { queries: 20, sources: 20, label: "Standard" },
  thorough: { queries: 45, sources: 35, label: "Gründlich" },
};

const WINDOW = 10;

interface Candidate {
  query: string;
  score: number;
  pos: number;
}

export function buildQueries(doc: PreparedDoc, maxQueries: number, skip?: Uint8Array): string[] {
  const cands: Candidate[] = [];
  const toks = doc.tokens;

  const addWindow = (a: number, b: number) => {
    let bestStart = a;
    let bestScore = -1;
    for (let s = a; s + WINDOW <= b; s++) {
      let score = 0;
      for (let x = s; x < s + WINDOW; x++) {
        if (doc.content[x]) score += 1 + Math.min(toks[x].w.length, 12) / 12;
      }
      if (score > bestScore) {
        bestScore = score;
        bestStart = s;
      }
    }
    const end = Math.min(b, bestStart + WINDOW);
    const words = [];
    for (let x = bestStart; x < end; x++) words.push(doc.text.slice(toks[x].s, toks[x].e));
    const content = words.length ? bestScore / words.length : 0;
    if (bestScore >= 4) cands.push({ query: words.join(" "), score: content, pos: bestStart });
  };

  for (const s of doc.sentences) {
    if (skip && (skip[s.t0] || skip[s.t1 - 1])) continue;
    const len = s.t1 - s.t0;
    if (len < 7) continue;
    if (len <= WINDOW + 4) {
      addWindow(s.t0, s.t1);
    } else if (len < 40) {
      addWindow(s.t0, s.t1);
    } else {
      // very long "sentence" (e.g. text without punctuation): chunk it
      for (let a = s.t0; a < s.t1; a += 25) addWindow(a, Math.min(s.t1, a + 25));
    }
  }

  if (cands.length === 0 && toks.length >= 6 && !skip?.some((x) => x)) {
    for (let a = 0; a < toks.length; a += 25) addWindow(a, Math.min(toks.length, a + 25));
  }

  if (cands.length <= maxQueries) return dedupe(cands.map((c) => c.query));

  // Spread queries evenly over the document; inside each bucket take the most distinctive one.
  const picked: Candidate[] = [];
  const bucket = cands.length / maxQueries;
  for (let b = 0; b < maxQueries; b++) {
    const slice = cands.slice(Math.floor(b * bucket), Math.floor((b + 1) * bucket));
    if (!slice.length) continue;
    picked.push(slice.reduce((x, y) => (y.score > x.score ? y : x)));
  }
  return dedupe(picked.map((c) => c.query));
}

function dedupe(qs: string[]): string[] {
  return [...new Set(qs)];
}

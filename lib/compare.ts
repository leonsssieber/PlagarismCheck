// Core comparison engine.
//
// 1. Verbatim detection: word n-gram (shingle) index of the source, greedy
//    extension to the longest common run, then merging of nearby runs so that
//    small edits (changed/inserted/removed words) still count as one match.
// 2. Paraphrase detection: sentence-level similarity of stemmed content words
//    and content-word bigrams against sentence windows of the source.
// 3. Aggregation: every word of the checked text is attributed to at most one
//    source, which yields the overall and per-source percentages.

import {
  findQuotedRanges,
  isStopWord,
  splitSentences,
  stem,
  tokenize,
  type Sentence,
  type Token,
} from "./text.ts";

export type SourceKind = "web" | "wikipedia" | "academic" | "reference" | "snippet";

export interface SourceDoc {
  id: string;
  url: string;
  title: string;
  text: string;
  kind: SourceKind;
  provider?: string;
}

export type MatchType = "exact" | "near" | "paraphrase";

export interface Match {
  /** token range in the checked text */
  t0: number;
  t1: number;
  /** character range in the source text */
  srcStart: number;
  srcEnd: number;
  type: MatchType;
  /** similarity 0..1 */
  score: number;
  /** number of words that actually match */
  words: number;
}

export interface PreparedDoc {
  text: string;
  tokens: Token[];
  sentences: Sentence[];
  stems: string[];
  content: boolean[];
}

export interface CompareOptions {
  /** shingle length */
  k?: number;
  /** minimum number of matching words for a verbatim match */
  minWords?: number;
  /** detect paraphrases */
  paraphrase?: boolean;
  /** paraphrase threshold (0..1) */
  paraphraseThreshold?: number;
}

const DEFAULTS: Required<CompareOptions> = {
  k: 3,
  minWords: 7,
  paraphrase: true,
  paraphraseThreshold: 0.55,
};

export function prepare(text: string): PreparedDoc {
  const tokens = tokenize(text);
  const sentences = splitSentences(text, tokens);
  const stems = tokens.map((t) => stem(t.w));
  const content = tokens.map((t) => t.w.length > 2 && !isStopWord(t.w) && !/^\d+$/.test(t.w));
  return { text, tokens, sentences, stems, content };
}

interface Run {
  i: number; // doc token index
  j: number; // source token index
  len: number;
}

function findRuns(doc: PreparedDoc, src: PreparedDoc, k: number): Run[] {
  const st = src.tokens;
  const index = new Map<string, number[]>();
  for (let j = 0; j + k <= st.length; j++) {
    let hasContent = false;
    for (let x = 0; x < k; x++) if (src.content[j + x]) hasContent = true;
    if (!hasContent) continue;
    let key = st[j].w;
    for (let x = 1; x < k; x++) key += " " + st[j + x].w;
    const arr = index.get(key);
    if (arr) {
      if (arr.length < 64) arr.push(j);
    } else index.set(key, [j]);
  }

  const dt = doc.tokens;
  const runs: Run[] = [];
  let i = 0;
  while (i + k <= dt.length) {
    let key = dt[i].w;
    for (let x = 1; x < k; x++) key += " " + dt[i + x].w;
    const cands = index.get(key);
    if (!cands) {
      i++;
      continue;
    }
    let bestJ = -1;
    let bestLen = 0;
    for (const j of cands) {
      let l = k;
      while (i + l < dt.length && j + l < st.length && dt[i + l].w === st[j + l].w) l++;
      if (l > bestLen) {
        bestLen = l;
        bestJ = j;
      }
    }
    runs.push({ i, j: bestJ, len: bestLen });
    i += bestLen;
  }
  return runs;
}

interface Segment {
  t0: number;
  t1: number;
  j0: number;
  j1: number;
  words: number;
  gaps: boolean;
}

function mergeRuns(runs: Run[]): Segment[] {
  const segs: Segment[] = [];
  for (const r of runs) {
    const last = segs[segs.length - 1];
    if (last) {
      const docGap = r.i - last.t1;
      const srcGap = r.j - last.j1;
      if (docGap <= 6 && srcGap >= -3 && srcGap <= 12) {
        last.t1 = r.i + r.len;
        last.j1 = Math.max(last.j1, r.j + r.len);
        last.words += r.len;
        last.gaps = last.gaps || docGap > 0 || srcGap !== 0;
        continue;
      }
    }
    segs.push({ t0: r.i, t1: r.i + r.len, j0: r.j, j1: r.j + r.len, words: r.len, gaps: false });
  }
  return segs;
}

function contentSet(doc: PreparedDoc, t0: number, t1: number): { uni: Set<string>; bi: Set<string> } {
  const uni = new Set<string>();
  const bi = new Set<string>();
  let prev: string | null = null;
  for (let t = t0; t < t1; t++) {
    if (!doc.content[t]) continue;
    const s = doc.stems[t];
    uni.add(s);
    if (prev) bi.add(prev + " " + s);
    prev = s;
  }
  return { uni, bi };
}

function findParaphrases(
  doc: PreparedDoc,
  src: PreparedDoc,
  covered: Uint8Array,
  threshold: number,
): Match[] {
  // Source windows: single sentences and pairs of consecutive sentences.
  const srcSets = src.sentences.map((s) => contentSet(src, s.t0, s.t1));
  const inverted = new Map<string, number[]>();
  srcSets.forEach((set, idx) => {
    for (const u of set.uni) {
      const arr = inverted.get(u);
      if (arr) arr.push(idx);
      else inverted.set(u, [idx]);
    }
  });

  const out: Match[] = [];
  for (const sent of doc.sentences) {
    const len = sent.t1 - sent.t0;
    if (len < 6) continue;
    let cov = 0;
    for (let t = sent.t0; t < sent.t1; t++) cov += covered[t];
    if (cov / len > 0.5) continue;

    const A = contentSet(doc, sent.t0, sent.t1);
    if (A.uni.size < 5) continue;

    const counts = new Map<number, number>();
    for (const u of A.uni) {
      const list = inverted.get(u);
      if (!list) continue;
      for (const idx of list) counts.set(idx, (counts.get(idx) ?? 0) + 1);
    }
    const minHits = Math.max(3, Math.floor(A.uni.size * 0.35));
    let best: { score: number; a: number; b: number; overlap: number } | null = null;
    for (const [idx, c] of counts) {
      if (c < minHits) continue;
      for (const span of [0, 1, -1]) {
        const a = Math.min(idx, idx + span);
        const b = Math.max(idx, idx + span);
        if (a < 0 || b >= srcSets.length) continue;
        const uni = span === 0 ? srcSets[idx].uni : new Set([...srcSets[a].uni, ...srcSets[b].uni]);
        const bi = span === 0 ? srcSets[idx].bi : new Set([...srcSets[a].bi, ...srcSets[b].bi]);
        let overlap = 0;
        for (const u of A.uni) if (uni.has(u)) overlap++;
        let biOverlap = 0;
        for (const x of A.bi) if (bi.has(x)) biOverlap++;
        const containment = overlap / A.uni.size;
        const precision = overlap / Math.max(1, uni.size);
        const biCont = A.bi.size ? biOverlap / A.bi.size : 0;
        if (precision < 0.3 || overlap < 5) continue;
        const score = 0.75 * containment + 0.25 * biCont;
        if (!best || score > best.score) best = { score, a, b, overlap };
      }
    }
    if (best && best.score >= threshold) {
      const sa = src.sentences[best.a];
      const sb = src.sentences[best.b];
      out.push({
        t0: sent.t0,
        t1: sent.t1,
        srcStart: sa.s,
        srcEnd: sb.e,
        type: "paraphrase",
        score: Math.min(1, best.score),
        words: best.overlap,
      });
    }
  }
  return out;
}

/** Compare a prepared document against a prepared source. */
export function compareDocs(doc: PreparedDoc, src: PreparedDoc, opts: CompareOptions = {}): Match[] {
  const o = { ...DEFAULTS, ...opts };
  if (!doc.tokens.length || !src.tokens.length) return [];
  const runs = findRuns(doc, src, o.k);
  const segs = mergeRuns(runs);
  const matches: Match[] = [];
  const covered = new Uint8Array(doc.tokens.length);
  for (const s of segs) {
    if (s.words < o.minWords) continue;
    let contentWords = 0;
    for (let t = s.t0; t < s.t1; t++) if (doc.content[t]) contentWords++;
    if (contentWords < 3) continue;
    const span = s.t1 - s.t0;
    const srcEndTok = Math.min(s.j1, src.tokens.length) - 1;
    matches.push({
      t0: s.t0,
      t1: s.t1,
      srcStart: src.tokens[s.j0].s,
      srcEnd: src.tokens[srcEndTok].e,
      type: s.gaps ? "near" : "exact",
      score: s.words / span,
      words: s.words,
    });
    for (let t = s.t0; t < s.t1; t++) covered[t] = 1;
  }
  if (o.paraphrase) {
    matches.push(...findParaphrases(doc, src, covered, o.paraphraseThreshold));
  }
  return matches.sort((a, b) => a.t0 - b.t0);
}

// ---------------------------------------------------------------------------
// Aggregation / report
// ---------------------------------------------------------------------------

export interface SourceReport {
  source: SourceDoc;
  matches: Match[];
  /** words of the checked text matched by this source (non-exclusive) */
  words: number;
  /** words attributed to this source in the final report */
  exclusiveWords: number;
  percent: number;
  exclusivePercent: number;
}

export type SegmentKind = "exact" | "near" | "paraphrase" | "citation";

export interface TextSegment {
  start: number;
  end: number;
  kind?: SegmentKind;
  sourceIdx?: number;
  matchIdx?: number;
}

export interface Report {
  totalWords: number;
  plagWords: number;
  paraphraseWords: number;
  citedWords: number;
  percent: number;
  sources: SourceReport[];
  segments: TextSegment[];
  flaggedSentences: number;
  totalSentences: number;
}

export interface ReportOptions extends CompareOptions {
  /** do not count text in quotation marks as plagiarism */
  excludeQuotes?: boolean;
}

export function buildReport(
  text: string,
  sources: SourceDoc[],
  opts: ReportOptions = {},
  preparedDoc?: PreparedDoc,
): Report {
  const doc = preparedDoc ?? prepare(text);
  const n = doc.tokens.length;

  const raw: SourceReport[] = [];
  for (const source of sources) {
    const src = prepare(source.text);
    const matches = compareDocs(doc, src, opts);
    if (!matches.length) continue;
    const mark = new Uint8Array(n);
    for (const m of matches) for (let t = m.t0; t < m.t1; t++) mark[t] = 1;
    let words = 0;
    for (let t = 0; t < n; t++) words += mark[t];
    raw.push({ source, matches, words, exclusiveWords: 0, percent: 0, exclusivePercent: 0 });
  }

  // Drop duplicate sources (e.g. mirrors) which cover exactly the same words
  raw.sort((a, b) => b.words - a.words);

  // Quote detection
  const quoted = new Uint8Array(n);
  if (opts.excludeQuotes !== false) {
    const ranges = findQuotedRanges(text);
    let r = 0;
    for (let t = 0; t < n; t++) {
      while (r < ranges.length && ranges[r][1] <= doc.tokens[t].s) r++;
      if (r < ranges.length && ranges[r][0] <= doc.tokens[t].s && doc.tokens[t].e <= ranges[r][1]) quoted[t] = 1;
    }
  }

  // Attribution: verbatim matches first (largest sources first), then paraphrases.
  const ownerSrc = new Int32Array(n).fill(-1);
  const ownerMatch = new Int32Array(n).fill(-1);
  const ownerKind: (SegmentKind | undefined)[] = new Array(n);
  const passes: Array<(m: Match) => boolean> = [(m) => m.type !== "paraphrase", (m) => m.type === "paraphrase"];
  for (const pass of passes) {
    raw.forEach((sr, si) => {
      sr.matches.forEach((m, mi) => {
        if (!pass(m)) return;
        for (let t = m.t0; t < m.t1; t++) {
          if (ownerSrc[t] !== -1) continue;
          ownerSrc[t] = si;
          ownerMatch[t] = mi;
          ownerKind[t] = quoted[t] ? "citation" : m.type;
        }
      });
    });
  }

  let plagWords = 0;
  let paraphraseWords = 0;
  let citedWords = 0;
  for (let t = 0; t < n; t++) {
    const k = ownerKind[t];
    if (!k) continue;
    if (k === "citation") citedWords++;
    else {
      plagWords++;
      if (k === "paraphrase") paraphraseWords++;
      raw[ownerSrc[t]].exclusiveWords++;
    }
  }

  // Keep only sources that still contribute something, re-index.
  const keep = raw
    .map((sr, idx) => ({ sr, idx }))
    .filter(({ sr }) => sr.exclusiveWords > 0 || sr.words >= 15);
  keep.sort((a, b) => b.sr.exclusiveWords - a.sr.exclusiveWords || b.sr.words - a.sr.words);
  const remap = new Map<number, number>();
  keep.forEach(({ idx }, newIdx) => remap.set(idx, newIdx));
  const sourcesOut = keep.map(({ sr }) => ({
    ...sr,
    percent: n ? (sr.words / n) * 100 : 0,
    exclusivePercent: n ? (sr.exclusiveWords / n) * 100 : 0,
  }));

  // Build text segments for rendering
  const segments: TextSegment[] = [];
  let pos = 0;
  let t = 0;
  while (t < n) {
    const si = ownerSrc[t];
    if (si === -1 || !remap.has(si)) {
      t++;
      continue;
    }
    const mi = ownerMatch[t];
    const kind = ownerKind[t];
    let u = t;
    while (u + 1 < n && ownerSrc[u + 1] === si && ownerMatch[u + 1] === mi && ownerKind[u + 1] === kind) u++;
    const start = doc.tokens[t].s;
    const end = doc.tokens[u].e;
    if (start > pos) segments.push({ start: pos, end: start });
    segments.push({ start, end, kind, sourceIdx: remap.get(si), matchIdx: mi });
    pos = end;
    t = u + 1;
  }
  if (pos < text.length) segments.push({ start: pos, end: text.length });

  let flaggedSentences = 0;
  for (const s of doc.sentences) {
    let c = 0;
    for (let x = s.t0; x < s.t1; x++) if (ownerKind[x] && ownerKind[x] !== "citation") c++;
    if (c / Math.max(1, s.t1 - s.t0) >= 0.5) flaggedSentences++;
  }

  return {
    totalWords: n,
    plagWords,
    paraphraseWords,
    citedWords,
    percent: n ? (plagWords / n) * 100 : 0,
    sources: sourcesOut,
    segments,
    flaggedSentences,
    totalSentences: doc.sentences.length,
  };
}

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

/** A source together with its matches against the checked text. */
export interface MatchedSource {
  source: SourceDoc;
  matches: Match[];
  /** stable colour index (order of discovery by size) */
  color: number;
}

export type Range = [number, number];

/** User decisions that change the report without re-running the comparison. */
export interface Adjustments {
  /** do not count text in quotation marks as plagiarism (default true) */
  excludeQuotes?: boolean;
  /** character ranges that are not checked at all (bibliography, ignored phrases) */
  excludedRanges?: Range[];
  /** character ranges the user marked as harmless */
  ignoredRanges?: Range[];
  /** character ranges the user marked as correctly cited */
  citedRanges?: Range[];
  /** source ids removed from the report */
  ignoredSources?: string[];
  /** source ids whose matches count as correctly cited */
  citedSources?: string[];
}

export interface SourceReport {
  source: SourceDoc;
  matches: Match[];
  color: number;
  /** words of the checked text matched by this source (non-exclusive) */
  words: number;
  /** words attributed to this source in the final report */
  exclusiveWords: number;
  /** words attributed to this source but counted as citation */
  citedWords: number;
  percent: number;
  exclusivePercent: number;
  /** the user marked this source as correctly cited */
  cited: boolean;
  /** the source (domain, DOI or title) is mentioned in the checked text, e.g. in the bibliography */
  mentioned: boolean;
}

export type SegmentKind = "exact" | "near" | "paraphrase" | "citation" | "excluded";

export interface TextSegment {
  start: number;
  end: number;
  kind?: SegmentKind;
  sourceIdx?: number;
  matchIdx?: number;
}

export interface Report {
  /** words that were checked (without excluded parts) */
  totalWords: number;
  excludedWords: number;
  plagWords: number;
  paraphraseWords: number;
  citedWords: number;
  percent: number;
  sources: SourceReport[];
  ignoredSources: MatchedSource[];
  segments: TextSegment[];
  flaggedSentences: number;
  totalSentences: number;
}

export interface ReportOptions extends CompareOptions {
  excludeQuotes?: boolean;
}

/** Runs the (expensive) comparison of the text against all sources. */
export function matchSources(doc: PreparedDoc, sources: SourceDoc[], opts: CompareOptions = {}): MatchedSource[] {
  const out: { source: SourceDoc; matches: Match[]; words: number }[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    const matches = compareDocs(doc, prepare(source.text), opts);
    if (!matches.length) continue;
    const mark = new Uint8Array(doc.tokens.length);
    for (const m of matches) for (let t = m.t0; t < m.t1; t++) mark[t] = 1;
    let words = 0;
    for (const x of mark) words += x;
    out.push({ source, matches, words });
  }
  out.sort((a, b) => b.words - a.words);
  return out.map((x, color) => ({ source: x.source, matches: x.matches, color }));
}

function rangeMask(doc: PreparedDoc, ranges: Range[] | undefined): Uint8Array {
  const mask = new Uint8Array(doc.tokens.length);
  if (!ranges?.length) return mask;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let r = 0;
  for (let t = 0; t < doc.tokens.length; t++) {
    const tok = doc.tokens[t];
    while (r < sorted.length && sorted[r][1] <= tok.s) r++;
    for (let k = r; k < sorted.length && sorted[k][0] < tok.e; k++) {
      if (sorted[k][1] > tok.s) {
        mask[t] = 1;
        break;
      }
    }
  }
  return mask;
}

function normalizeLoose(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}.\/]+/gu, " ")
    .trim();
}

/** Does the checked text mention the source (URL, domain, DOI or title)? */
export function sourceMentioned(text: string, source: SourceDoc): boolean {
  if (!source.url) return false;
  const lower = text.toLowerCase();
  try {
    const u = new URL(source.url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "doi.org" || host.endsWith(".doi.org")) {
      const doi = decodeURIComponent(u.pathname.slice(1)).toLowerCase();
      if (doi && lower.includes(doi)) return true;
    } else if (/wikipedia\.org$/.test(host)) {
      const article = decodeURIComponent(u.pathname.replace(/^\/wiki\//, "")).replace(/_/g, " ").toLowerCase();
      if (lower.includes("wikipedia") && article && lower.includes(article)) return true;
    } else if (lower.includes(host)) {
      return true;
    }
  } catch {
    /* ignore */
  }
  const title = normalizeLoose(source.title.replace(/\s[–|-]\s.*$/, "").replace(/\(\d{4}\)\s*$/, ""));
  if (title.length >= 20) {
    const head = title.split(" ").slice(0, 8).join(" ");
    if (head.length >= 20 && normalizeLoose(text).includes(head)) return true;
  }
  return false;
}

/** Builds the report from pre-computed matches and the user's adjustments (cheap). */
export function assembleReport(doc: PreparedDoc, matched: MatchedSource[], adj: Adjustments = {}): Report {
  const text = doc.text;
  const n = doc.tokens.length;
  const ignoredIds = new Set(adj.ignoredSources ?? []);
  const citedIds = new Set(adj.citedSources ?? []);
  const active = matched.filter((m) => !ignoredIds.has(m.source.id));
  const ignoredSources = matched.filter((m) => ignoredIds.has(m.source.id));

  const excluded = rangeMask(doc, adj.excludedRanges);
  const ignored = rangeMask(doc, adj.ignoredRanges);
  const cited = rangeMask(doc, adj.citedRanges);
  if (adj.excludeQuotes !== false) {
    const q = rangeMask(doc, findQuotedRanges(text));
    for (let t = 0; t < n; t++) if (q[t]) cited[t] = 1;
  }

  // Order: largest sources first (by non-exclusive coverage of checked words)
  const stats = active.map((ms) => {
    const mark = new Uint8Array(n);
    for (const m of ms.matches) for (let t = m.t0; t < m.t1; t++) if (!excluded[t] && !ignored[t]) mark[t] = 1;
    let words = 0;
    for (const x of mark) words += x;
    return { ms, words, exclusiveWords: 0, citedWords: 0 };
  });
  stats.sort((a, b) => b.words - a.words);

  const ownerSrc = new Int32Array(n).fill(-1);
  const ownerMatch = new Int32Array(n).fill(-1);
  const ownerKind: (SegmentKind | undefined)[] = new Array(n);
  const passes: Array<(m: Match) => boolean> = [(m) => m.type !== "paraphrase", (m) => m.type === "paraphrase"];
  for (const pass of passes) {
    stats.forEach((st, si) => {
      const srcCited = citedIds.has(st.ms.source.id);
      st.ms.matches.forEach((m, mi) => {
        if (!pass(m)) return;
        for (let t = m.t0; t < m.t1; t++) {
          if (ownerSrc[t] !== -1 || excluded[t] || ignored[t]) continue;
          ownerSrc[t] = si;
          ownerMatch[t] = mi;
          ownerKind[t] = cited[t] || srcCited ? "citation" : m.type;
        }
      });
    });
  }

  let plagWords = 0;
  let paraphraseWords = 0;
  let citedWords = 0;
  let excludedWords = 0;
  for (let t = 0; t < n; t++) {
    if (excluded[t]) {
      excludedWords++;
      continue;
    }
    const k = ownerKind[t];
    if (!k) continue;
    if (k === "citation") {
      citedWords++;
      stats[ownerSrc[t]].citedWords++;
    } else {
      plagWords++;
      if (k === "paraphrase") paraphraseWords++;
      stats[ownerSrc[t]].exclusiveWords++;
    }
  }
  const total = n - excludedWords;

  const keep = stats
    .map((st, idx) => ({ st, idx }))
    .filter(({ st }) => st.exclusiveWords > 0 || st.citedWords > 0 || st.words >= 15);
  keep.sort((a, b) => b.st.exclusiveWords - a.st.exclusiveWords || b.st.citedWords - a.st.citedWords || b.st.words - a.st.words);
  const remap = new Map<number, number>();
  keep.forEach(({ idx }, newIdx) => remap.set(idx, newIdx));
  const sources: SourceReport[] = keep.map(({ st }) => ({
    source: st.ms.source,
    matches: st.ms.matches,
    color: st.ms.color,
    words: st.words,
    exclusiveWords: st.exclusiveWords,
    citedWords: st.citedWords,
    percent: total ? (st.words / total) * 100 : 0,
    exclusivePercent: total ? (st.exclusiveWords / total) * 100 : 0,
    cited: citedIds.has(st.ms.source.id),
    mentioned: sourceMentioned(text, st.ms.source),
  }));

  // Segments for rendering
  const segments: TextSegment[] = [];
  let pos = 0;
  let t = 0;
  while (t < n) {
    const si = ownerSrc[t];
    const isExcl = excluded[t] === 1;
    if (!isExcl && (si === -1 || !remap.has(si))) {
      t++;
      continue;
    }
    let u = t;
    if (isExcl) {
      while (u + 1 < n && excluded[u + 1]) u++;
    } else {
      const mi = ownerMatch[t];
      const kind = ownerKind[t];
      while (u + 1 < n && ownerSrc[u + 1] === si && ownerMatch[u + 1] === mi && ownerKind[u + 1] === kind) u++;
    }
    const start = doc.tokens[t].s;
    const end = doc.tokens[u].e;
    if (start > pos) segments.push({ start: pos, end: start });
    if (isExcl) segments.push({ start, end, kind: "excluded" });
    else segments.push({ start, end, kind: ownerKind[t], sourceIdx: remap.get(si), matchIdx: ownerMatch[t] });
    pos = end;
    t = u + 1;
  }
  if (pos < text.length) segments.push({ start: pos, end: text.length });

  let flaggedSentences = 0;
  let totalSentences = 0;
  for (const s of doc.sentences) {
    let c = 0;
    let checked = 0;
    for (let x = s.t0; x < s.t1; x++) {
      if (excluded[x]) continue;
      checked++;
      if (ownerKind[x] && ownerKind[x] !== "citation" && remap.has(ownerSrc[x])) c++;
    }
    if (!checked) continue;
    totalSentences++;
    if (c / checked >= 0.5) flaggedSentences++;
  }

  return {
    totalWords: total,
    excludedWords,
    plagWords,
    paraphraseWords,
    citedWords,
    percent: total ? (plagWords / total) * 100 : 0,
    sources,
    ignoredSources,
    segments,
    flaggedSentences,
    totalSentences,
  };
}

/** Convenience: compare and assemble in one step. */
export function buildReport(
  text: string,
  sources: SourceDoc[],
  opts: ReportOptions = {},
  preparedDoc?: PreparedDoc,
  adj: Adjustments = {},
): Report {
  const doc = preparedDoc ?? prepare(text);
  return assembleReport(doc, matchSources(doc, sources, opts), { excludeQuotes: opts.excludeQuotes, ...adj });
}

// ---------------------------------------------------------------------------
// Parts of the text that should not be checked
// ---------------------------------------------------------------------------

const BIBLIO_RE =
  /^[ \t]*(?:\d+(?:\.\d+)*\.?[ \t]+)?(?:literaturverzeichnis|literatur|quellenverzeichnis|quellen|quellenangaben|internetquellen|bibliographie|bibliografie|references|reference list|bibliography|works cited|sources)[ \t]*:?[ \t]*$/gim;

/** Finds the bibliography (from its heading to the end of the text). */
export function findBibliography(text: string): Range | null {
  let found: Range | null = null;
  for (const m of text.matchAll(BIBLIO_RE)) {
    const idx = m.index ?? 0;
    // Only headings in the second half of the text (not a table of contents entry)
    if (idx >= text.length * 0.4) {
      found = [idx, text.length];
      break;
    }
  }
  return found;
}

/** Finds all occurrences of the given phrases (case-insensitive). */
export function findPhrases(text: string, phrases: string[]): Range[] {
  const out: Range[] = [];
  const lower = text.toLowerCase();
  for (const raw of phrases) {
    const p = raw.trim().toLowerCase();
    if (p.length < 3) continue;
    let i = 0;
    while ((i = lower.indexOf(p, i)) !== -1) {
      out.push([i, i + p.length]);
      i += p.length;
    }
  }
  return out;
}

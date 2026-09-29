// Orchestrates a plagiarism check in the browser: query generation, search,
// source retrieval (through the server API routes) and the local comparison.

import { findBibliography, findPhrases, matchSources, prepare, type MatchedSource, type Range, type ReportOptions, type SourceDoc } from "../compare.ts";
import { buildQueries, DEPTH_SETTINGS, type Depth } from "../queries.ts";
import { detectLanguage } from "../text.ts";

export type Sensitivity = "low" | "normal" | "high";

export interface CheckSettings {
  depth: Depth;
  web: boolean;
  wikipedia: boolean;
  academic: boolean;
  excludeQuotes: boolean;
  sensitivity: Sensitivity;
  excludeDomains: string[];
  /** do not check the bibliography */
  ignoreBibliography: boolean;
  /** phrases / passages that are not checked (one per entry) */
  ignorePhrases: string[];
  references: SourceDoc[];
}

export interface CheckProgress {
  phase: "search" | "fetch" | "compare" | "done";
  percent: number;
  message: string;
}

export interface CheckStats {
  queries: number;
  candidates: number;
  fetched: number;
  failed: number;
  searchErrors: string[];
  webHits: number;
}

export interface CheckResult {
  id: string;
  date: string;
  text: string;
  matched: MatchedSource[];
  /** parts of the text that were not checked */
  excludedRanges: Range[];
  bibliography: Range | null;
  excludeQuotes: boolean;
  stats: CheckStats;
  settings: { depth: Depth; sensitivity: Sensitivity };
}

interface Hit {
  url: string;
  title: string;
  snippet: string;
  provider: string;
  kind: "web" | "wikipedia" | "academic";
  text?: string;
}

interface Candidate {
  url: string;
  title: string;
  snippets: Set<string>;
  providers: Set<string>;
  kind: Hit["kind"];
  text?: string;
  hits: number;
  overlap: number;
}

const SENSITIVITY: Record<Sensitivity, ReportOptions> = {
  low: { minWords: 10, paraphraseThreshold: 0.68 },
  normal: { minWords: 7, paraphraseThreshold: 0.55 },
  high: { minWords: 5, paraphraseThreshold: 0.47 },
};

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^www\./, "").replace(/^(\w\w)\.m\.wikipedia/, "$1.wikipedia");
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|source$)/.test(p)) u.searchParams.delete(p);
    }
    return u.toString().replace(/\/$/, "");
  } catch {
    return raw;
  }
}

function domainExcluded(url: string, excluded: string[]): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return excluded.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return true;
  }
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>, signal?: AbortSignal) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      if (signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export async function runCheck(
  text: string,
  settings: CheckSettings,
  onProgress: (p: CheckProgress) => void,
  signal?: AbortSignal,
): Promise<CheckResult> {
  const doc = prepare(text);
  const bibliography = settings.ignoreBibliography ? findBibliography(text) : null;
  const excludedRanges: Range[] = [...(bibliography ? [bibliography] : []), ...findPhrases(text, settings.ignorePhrases)];
  const skip = new Uint8Array(doc.tokens.length);
  for (const [a, b] of excludedRanges) doc.tokens.forEach((t, i) => { if (t.s >= a && t.e <= b) skip[i] = 1; });
  const lang = detectLanguage(doc.tokens);
  const depth = DEPTH_SETTINGS[settings.depth];
  const stats: CheckStats = { queries: 0, candidates: 0, fetched: 0, failed: 0, searchErrors: [], webHits: 0 };
  const sources: SourceDoc[] = [...settings.references];
  const excluded = settings.excludeDomains.map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "")).filter(Boolean);

  const anyOnline = settings.web || settings.wikipedia || settings.academic;
  if (anyOnline) {
    // ---------------- search ----------------
    const queries = buildQueries(doc, depth.queries, skip);
    stats.queries = queries.length;
    const batches: string[][] = [];
    for (let i = 0; i < queries.length; i += 4) batches.push(queries.slice(i, i + 4));
    const candidates = new Map<string, Candidate>();
    let done = 0;
    onProgress({ phase: "search", percent: 2, message: `Suche nach Quellen (0/${queries.length} Abschnitte)…` });

    const docShingles = new Set<string>();
    for (let i = 0; i + 3 <= doc.tokens.length; i++) {
      docShingles.add(doc.tokens[i].w + " " + doc.tokens[i + 1].w + " " + doc.tokens[i + 2].w);
    }
    const overlapScore = (s: string) => {
      const t = prepare(s).tokens;
      let c = 0;
      for (let i = 0; i + 3 <= t.length; i++) if (docShingles.has(t[i].w + " " + t[i + 1].w + " " + t[i + 2].w)) c++;
      return c;
    };

    await pool(
      batches,
      3,
      async (batch) => {
        try {
          const res = await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              queries: batch,
              lang,
              web: settings.web,
              wikipedia: settings.wikipedia,
              academic: settings.academic,
            }),
            signal,
          });
          if (!res.ok) throw new Error(`Suche fehlgeschlagen (HTTP ${res.status})`);
          const data: { results: { query: string; hits: Hit[] }[]; errors: string[] } = await res.json();
          stats.searchErrors.push(...data.errors);
          for (const r of data.results) {
            for (const h of r.hits) {
              if (!h.url || domainExcluded(h.url, excluded)) continue;
              if (h.kind === "web") stats.webHits++;
              const key = normalizeUrl(h.url);
              let c = candidates.get(key);
              if (!c) {
                c = { url: h.url, title: h.title, snippets: new Set(), providers: new Set(), kind: h.kind, text: h.text, hits: 0, overlap: 0 };
                candidates.set(key, c);
              }
              c.hits++;
              c.providers.add(h.provider);
              if (h.snippet && !c.snippets.has(h.snippet)) {
                c.snippets.add(h.snippet);
                c.overlap += overlapScore(h.snippet);
              }
            }
          }
        } catch (e) {
          if ((e as Error).name === "AbortError") throw e;
          stats.searchErrors.push((e as Error).message);
        }
        done += batch.length;
        onProgress({
          phase: "search",
          percent: 2 + (done / queries.length) * 38,
          message: `Suche nach Quellen (${done}/${queries.length} Abschnitte)…`,
        });
      },
      signal,
    );

    // ---------------- rank + fetch ----------------
    const ranked = [...candidates.values()]
      .map((c) => ({ c, score: c.hits * 2 + c.overlap * 3 + (c.text ? 1 : 0) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, depth.sources)
      .map((x) => x.c);
    stats.candidates = ranked.length;

    let fetchedCount = 0;
    onProgress({ phase: "fetch", percent: 40, message: `Lade ${ranked.length} mögliche Quellen…` });
    await pool(
      ranked,
      5,
      async (c) => {
        const snippetText = [...c.snippets].join(" … ");
        if (c.text) {
          sources.push({ id: c.url, url: c.url, title: c.title, text: c.text, kind: c.kind, provider: [...c.providers].join(", ") });
          stats.fetched++;
        } else {
          try {
            const res = await fetch("/api/fetch", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: c.url }),
              signal,
            });
            const data = await res.json();
            if (!res.ok || !data.text) throw new Error(data.error || "leer");
            sources.push({
              id: c.url,
              url: data.url || c.url,
              title: c.title || data.title,
              text: data.text + (snippetText ? "\n\n" + snippetText : ""),
              kind: c.kind,
              provider: [...c.providers].join(", "),
            });
            stats.fetched++;
          } catch (e) {
            if ((e as Error).name === "AbortError") throw e;
            stats.failed++;
            // Page not retrievable (paywall, bot protection …): fall back to the search snippets.
            if (snippetText && c.overlap > 0) {
              sources.push({ id: c.url, url: c.url, title: c.title, text: snippetText, kind: "snippet", provider: [...c.providers].join(", ") });
            }
          }
        }
        fetchedCount++;
        onProgress({
          phase: "fetch",
          percent: 40 + (fetchedCount / Math.max(1, ranked.length)) * 50,
          message: `Lade mögliche Quellen (${fetchedCount}/${ranked.length})…`,
        });
      },
      signal,
    );
  }

  onProgress({ phase: "compare", percent: 92, message: "Vergleiche Text mit den Quellen…" });
  await new Promise((r) => setTimeout(r, 30));
  const matched = matchSources(doc, sources, SENSITIVITY[settings.sensitivity]);
  onProgress({ phase: "done", percent: 100, message: "Fertig" });
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    date: new Date().toISOString(),
    text,
    matched,
    excludedRanges,
    bibliography,
    excludeQuotes: settings.excludeQuotes,
    stats,
    settings: { depth: settings.depth, sensitivity: settings.sensitivity },
  };
}

"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { CheckResult } from "@/lib/client/runCheck";
import type { Match, SegmentKind, SourceReport } from "@/lib/compare";
import { normalizeWord, tokenize } from "@/lib/text";

const KIND_LABEL: Record<SegmentKind, string> = {
  exact: "Wörtlich übernommen",
  near: "Leicht verändert",
  paraphrase: "Paraphrase (umformuliert)",
  citation: "Zitat (in Anführungszeichen)",
};

const SOURCE_KIND_LABEL: Record<string, string> = {
  web: "Web",
  wikipedia: "Wikipedia",
  academic: "Wissenschaft",
  reference: "Eigenes Dokument",
  snippet: "Suchauszug",
};

export function hueFor(idx: number): number {
  return Math.round((idx * 137.508 + 210) % 360);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function verdict(p: number): { text: string; color: string } {
  if (p < 5) return { text: "Keine nennenswerten Übereinstimmungen", color: "var(--good)" };
  if (p < 15) return { text: "Geringe Übereinstimmung", color: "var(--good)" };
  if (p < 30) return { text: "Deutliche Übereinstimmung", color: "var(--warn)" };
  return { text: "Hohe Übereinstimmung – Plagiatsverdacht", color: "var(--bad)" };
}

const fmt = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 1 });

/** Renders a string and emphasises words contained in `words`. */
function emphasise(str: string, words: Set<string>): ReactNode[] {
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

interface Props {
  result: CheckResult;
  onNew: () => void;
  onEdit: () => void;
}

export default function ReportView({ result, onNew, onEdit }: Props) {
  const { report, stats, text } = result;
  const [selected, setSelected] = useState<number | null>(null);
  const [active, setActive] = useState<{ s: number; m: number } | null>(null);
  const tokens = useMemo(() => tokenize(text), [text]);
  const v = verdict(report.percent);

  const segmentsBySource = useMemo(() => {
    const map = new Map<number, number[]>();
    report.segments.forEach((seg, i) => {
      if (seg.sourceIdx === undefined) return;
      const arr = map.get(seg.sourceIdx) ?? [];
      arr.push(i);
      map.set(seg.sourceIdx, arr);
    });
    return map;
  }, [report]);

  const focusSegment = (segIdx: number) => {
    const seg = report.segments[segIdx];
    if (seg.sourceIdx === undefined || seg.matchIdx === undefined) return;
    setActive({ s: seg.sourceIdx, m: seg.matchIdx });
    document.getElementById(`seg-${segIdx}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const selectSource = (idx: number) => {
    if (selected === idx) {
      setSelected(null);
      return;
    }
    setSelected(idx);
    const first = segmentsBySource.get(idx)?.[0];
    if (first !== undefined) focusSegment(first);
  };

  const step = (dir: 1 | -1) => {
    if (!active) return;
    const list = segmentsBySource.get(active.s) ?? [];
    const cur = list.findIndex((i) => report.segments[i].matchIdx === active.m);
    const next = list[(cur + dir + list.length) % list.length];
    if (next !== undefined) focusSegment(next);
  };

  const onlineChecked = stats.queries > 0;
  const noWeb = onlineChecked && stats.webHits === 0;

  return (
    <>
      <div className="print-only" style={{ marginBottom: 12 }}>
        <strong>Plagiatsbericht</strong> · erstellt am {new Date(result.date).toLocaleString("de-DE")}
      </div>
      <section className="panel report-head">
        <div className="gauge" style={{ "--p": Math.min(100, report.percent), "--gauge-color": v.color } as CSSProperties}>
          <div className="gauge-inner">
            <div>
              <div className="gauge-value">{fmt(report.percent)} %</div>
              <div className="gauge-label">Übereinstimmung</div>
            </div>
          </div>
        </div>
        <div>
          <p className="verdict" style={{ color: v.color }}>
            {v.text}
          </p>
          <div className="stats">
            <span>
              <b>{report.totalWords.toLocaleString("de-DE")}</b> Wörter geprüft
            </span>
            <span>
              <b>{report.plagWords.toLocaleString("de-DE")}</b> Wörter auffällig
            </span>
            <span>
              <b>{report.sources.length}</b> Quellen gefunden
            </span>
            <span>
              <b>
                {report.flaggedSentences}/{report.totalSentences}
              </b>{" "}
              Sätze betroffen
            </span>
            {report.paraphraseWords > 0 && (
              <span>
                davon <b>{fmt((report.paraphraseWords / report.totalWords) * 100)} %</b> Paraphrasen
              </span>
            )}
            {report.citedWords > 0 && (
              <span>
                <b>{fmt((report.citedWords / report.totalWords) * 100)} %</b> als Zitat gekennzeichnet
              </span>
            )}
          </div>
          <div className="stats" style={{ marginTop: 6, fontSize: 12 }}>
            {onlineChecked
              ? `${stats.queries} Suchanfragen · ${stats.candidates} Kandidaten · ${stats.fetched} Quellen vollständig verglichen${stats.failed ? ` · ${stats.failed} nicht abrufbar` : ""}`
              : "Nur mit eigenen Vergleichsdokumenten geprüft"}
          </div>
        </div>
        <div className="head-actions">
          <button className="btn" onClick={() => window.print()}>
            Bericht drucken / PDF
          </button>
          <button className="btn" onClick={onEdit}>
            Text bearbeiten
          </button>
          <button className="btn btn-primary" onClick={onNew}>
            Neue Prüfung
          </button>
        </div>
      </section>

      {noWeb && (
        <div className="warn-box no-print">
          Die Websuche hat keine Treffer geliefert – vermutlich wurde die kostenlose Suche ohne API-Schlüssel
          blockiert. Für zuverlässige Ergebnisse einen kostenlosen Such-API-Schlüssel hinterlegen (siehe README).
          {stats.searchErrors.length > 0 && <div style={{ marginTop: 4, color: "var(--muted)" }}>Details: {stats.searchErrors.slice(0, 3).join(" · ")}</div>}
        </div>
      )}

      <div className="report-grid">
        <section className="panel doc-view">
          <div className="legend">
            <span>
              <i className="sw" style={{ background: "hsl(210 85% 80%)" }} /> Wörtlich
            </span>
            <span>
              <i className="sw" style={{ background: "hsl(210 85% 80% / .75)", borderBottom: "2px dashed hsl(210 70% 45%)" }} /> Leicht verändert
            </span>
            <span>
              <i className="sw" style={{ background: "hsl(210 85% 80% / .4)", borderBottom: "2px dotted hsl(210 70% 45%)" }} /> Paraphrase
            </span>
            <span>
              <i className="sw" style={{ background: "var(--cite)" }} /> Zitat
            </span>
            <span>Farbe = Quelle · Klick auf eine Markierung zeigt den Vergleich</span>
          </div>
          <div className="doc-text">
            {report.segments.map((seg, i) => {
              const chunk = text.slice(seg.start, seg.end);
              if (seg.sourceIdx === undefined || !seg.kind) return <span key={i}>{chunk}</span>;
              const isActive = active && active.s === seg.sourceIdx && active.m === seg.matchIdx;
              const dim = selected !== null && selected !== seg.sourceIdx;
              return (
                <mark
                  key={i}
                  id={`seg-${i}`}
                  className={`hl ${seg.kind} ${dim ? "dim" : ""} ${isActive ? "active" : ""}`}
                  style={{ "--h": hueFor(seg.sourceIdx) } as CSSProperties}
                  title={`${KIND_LABEL[seg.kind]} – ${report.sources[seg.sourceIdx].source.title}`}
                  onClick={() => {
                    setActive({ s: seg.sourceIdx!, m: seg.matchIdx! });
                    if (window.innerWidth <= 960) {
                      setTimeout(() => document.getElementById("match-detail")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
                    }
                  }}
                >
                  {chunk}
                </mark>
              );
            })}
          </div>
        </section>

        <aside className="side">
          {active && report.sources[active.s] && (
            <Detail
              sr={report.sources[active.s]}
              idx={active.s}
              match={report.sources[active.s].matches[active.m]}
              text={text}
              tokens={tokens}
              quoted={report.segments.some((s) => s.sourceIdx === active.s && s.matchIdx === active.m && s.kind === "citation")}
              onClose={() => setActive(null)}
              onStep={step}
              count={segmentsBySource.get(active.s)?.length ?? 0}
            />
          )}
          <section className="panel sources">
            <h2 style={{ padding: "0 8px" }}>Gefundene Quellen</h2>
            {report.sources.length === 0 && (
              <div className="empty">Es wurden keine übereinstimmenden Quellen gefunden.</div>
            )}
            {report.sources.map((sr, idx) => (
              <div
                key={sr.source.id}
                className={`source-item ${selected === idx ? "selected" : ""}`}
                style={{ "--h": hueFor(idx) } as CSSProperties}
                onClick={() => selectSource(idx)}
              >
                <div className="source-color" />
                <div style={{ minWidth: 0 }}>
                  <div className="source-title">{sr.source.title || domainOf(sr.source.url)}</div>
                  <div className="source-meta">
                    <span className="badge">{SOURCE_KIND_LABEL[sr.source.kind] ?? sr.source.kind}</span>
                    {sr.source.url ? (
                      <a href={sr.source.url} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
                        {domainOf(sr.source.url)} ↗
                      </a>
                    ) : (
                      sr.source.provider
                    )}
                  </div>
                  <div className="print-only" style={{ fontSize: 11, wordBreak: "break-all" }}>
                    {sr.source.url}
                  </div>
                </div>
                <div className="source-pct">
                  {fmt(sr.exclusivePercent)} %
                  <small>{segmentsBySource.get(idx)?.length ?? 0} Stellen</small>
                </div>
              </div>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}

interface DetailProps {
  sr: SourceReport;
  idx: number;
  match: Match;
  text: string;
  tokens: ReturnType<typeof tokenize>;
  quoted: boolean;
  count: number;
  onClose: () => void;
  onStep: (dir: 1 | -1) => void;
}

function Detail({ sr, idx, match, text, tokens, quoted, count, onClose, onStep }: DetailProps) {
  const docStart = tokens[match.t0].s;
  const docEnd = tokens[match.t1 - 1].e;
  const docPart = text.slice(docStart, docEnd);
  const srcText = sr.source.text;
  const ctxBefore = srcText.slice(Math.max(0, match.srcStart - 140), match.srcStart);
  const ctxAfter = srcText.slice(match.srcEnd, match.srcEnd + 140);
  const srcPart = srcText.slice(match.srcStart, match.srcEnd);

  const docWords = new Set(tokenize(docPart).map((t) => t.w));
  const srcWords = new Set(tokenize(srcPart).map((t) => normalizeWord(t.w)));
  const kind: SegmentKind = quoted ? "citation" : match.type;

  return (
    <section id="match-detail" className="panel detail" style={{ "--h": hueFor(idx) } as CSSProperties}>
      <div className="detail-head">
        <h3>
          {KIND_LABEL[kind]} · {Math.round(match.score * 100)} % Ähnlichkeit
        </h3>
        <button className="btn btn-sm" onClick={onClose} aria-label="Schließen">
          ✕
        </button>
      </div>
      <div className="compare-block">
        <div className="lbl">Dein Text</div>
        {emphasise(docPart, srcWords)}
      </div>
      <div className="compare-block">
        <div className="lbl">Quelle{sr.source.kind === "snippet" ? " (Suchmaschinen-Auszug)" : ""}</div>
        <span className="ctx">{ctxBefore.length ? "…" + ctxBefore.replace(/^\S*\s/, "") : ""}</span>
        {emphasise(srcPart, docWords)}
        <span className="ctx">{ctxAfter.length ? ctxAfter.replace(/\s\S*$/, "") + "…" : ""}</span>
      </div>
      <div style={{ fontSize: 13, marginBottom: 10 }}>
        <strong>{sr.source.title}</strong>
        <br />
        {sr.source.url ? (
          <a href={sr.source.url} target="_blank" rel="noreferrer noopener" style={{ wordBreak: "break-all" }}>
            {sr.source.url}
          </a>
        ) : (
          <span style={{ color: "var(--muted)" }}>{sr.source.provider}</span>
        )}
      </div>
      {count > 1 && (
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-sm" onClick={() => onStep(-1)}>
            ← Vorherige Stelle
          </button>
          <button className="btn btn-sm" onClick={() => onStep(1)}>
            Nächste Stelle →
          </button>
        </div>
      )}
    </section>
  );
}

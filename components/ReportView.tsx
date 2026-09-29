"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { CheckResult } from "@/lib/client/runCheck";
import type { UserAdjustments } from "@/lib/client/history";
import { assembleReport, prepare, type Match, type Range, type Report, type SegmentKind, type SourceReport } from "@/lib/compare";
import { tokenize, type Token } from "@/lib/text";
import { KIND_LABEL, domainOf, emphasise, hueFor } from "./shared";
import Synopsis from "./Synopsis";

const SOURCE_KIND_LABEL: Record<string, string> = {
  web: "Web",
  wikipedia: "Wikipedia",
  academic: "Wissenschaft",
  reference: "Eigenes Dokument",
  snippet: "Suchauszug",
};

const FILTER_KINDS: SegmentKind[] = ["exact", "near", "paraphrase", "citation"];

function verdict(p: number): { text: string; color: string } {
  if (p < 5) return { text: "Keine nennenswerten Übereinstimmungen", color: "var(--good)" };
  if (p < 15) return { text: "Geringe Übereinstimmung", color: "var(--good)" };
  if (p < 30) return { text: "Deutliche Übereinstimmung", color: "var(--warn)" };
  return { text: "Hohe Übereinstimmung – Plagiatsverdacht", color: "var(--bad)" };
}

const fmt = (n: number) => n.toLocaleString("de-DE", { maximumFractionDigits: 1 });


function matchRange(tokens: Token[], m: Match): Range {
  return [tokens[m.t0].s, tokens[m.t1 - 1].e];
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

interface Props {
  result: CheckResult;
  adjustments: UserAdjustments;
  onAdjustmentsChange: (adj: UserAdjustments, report: Report) => void;
  onNew: () => void;
  onEdit: () => void;
}

export default function ReportView({ result, adjustments, onAdjustmentsChange, onNew, onEdit }: Props) {
  const { stats, text } = result;
  const [adj, setAdj] = useState<UserAdjustments>(adjustments);
  const [selected, setSelected] = useState<string | null>(null);
  const [active, setActive] = useState<{ s: number; m: number } | null>(null);
  const [hidden, setHidden] = useState<SegmentKind[]>([]);
  const [synopsis, setSynopsis] = useState<number | null>(null);
  const [showIgnored, setShowIgnored] = useState(false);

  const doc = useMemo(() => prepare(text), [text]);
  const tokens = doc.tokens;
  const report = useMemo(
    () =>
      assembleReport(doc, result.matched, {
        excludeQuotes: result.excludeQuotes,
        excludedRanges: result.excludedRanges,
        ...adj,
      }),
    [doc, result, adj],
  );

  // Persist decisions (and the resulting percentage) whenever they change
  useEffect(() => {
    onAdjustmentsChange(adj, report);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adj]);

  // Keep the active match valid after re-assembling the report
  useEffect(() => {
    if (active && !report.sources[active.s]?.matches[active.m]) setActive(null);
  }, [report, active]);

  const v = verdict(report.percent);
  const selectedIdx = selected === null ? null : report.sources.findIndex((s) => s.source.id === selected);

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
    const id = report.sources[idx].source.id;
    if (selected === id) {
      setSelected(null);
      return;
    }
    setSelected(id);
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

  const update = (patch: Partial<UserAdjustments>) => setAdj((a) => ({ ...a, ...patch }));
  const resetAll = () => {
    setAdj({ ignoredRanges: [], citedRanges: [], ignoredSources: [], citedSources: [] });
    setActive(null);
  };
  const adjustCount = adj.ignoredRanges.length + adj.citedRanges.length + adj.ignoredSources.length + adj.citedSources.length;

  const onlineChecked = stats.queries > 0;
  const noWeb = onlineChecked && stats.webHits === 0;
  const excludedPct = report.totalWords + report.excludedWords ? (report.excludedWords / (report.totalWords + report.excludedWords)) * 100 : 0;

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
              <b>{report.sources.length}</b> Quellen
            </span>
            <span>
              <b>
                {report.flaggedSentences}/{report.totalSentences}
              </b>{" "}
              Sätze betroffen
            </span>
            {report.paraphraseWords > 0 && (
              <span>
                davon <b>{fmt((report.paraphraseWords / Math.max(1, report.totalWords)) * 100)} %</b> Paraphrasen
              </span>
            )}
            {report.citedWords > 0 && (
              <span>
                <b>{fmt((report.citedWords / Math.max(1, report.totalWords)) * 100)} %</b> zitiert
              </span>
            )}
          </div>
          <div className="stats" style={{ marginTop: 6, fontSize: 12 }}>
            <span>
              {onlineChecked
                ? `${stats.queries} Suchanfragen · ${stats.candidates} Kandidaten · ${stats.fetched} Quellen vollständig verglichen${stats.failed ? ` · ${stats.failed} nicht abrufbar` : ""}`
                : "Nur mit eigenen Vergleichsdokumenten geprüft"}
            </span>
            {report.excludedWords > 0 && (
              <span>
                {report.excludedWords.toLocaleString("de-DE")} Wörter ({fmt(excludedPct)} %) nicht geprüft
                {result.bibliography ? " – u. a. Literaturverzeichnis" : ""}
              </span>
            )}
            {adjustCount > 0 && (
              <span className="no-print">
                {adjustCount} manuelle Anpassung{adjustCount === 1 ? "" : "en"} ·{" "}
                <button className="inline-link" onClick={resetAll}>
                  zurücksetzen
                </button>
              </span>
            )}
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
          Die Websuche hat keine Treffer geliefert – eventuell wurde die Suche blockiert oder der API-Schlüssel ist
          ungültig bzw. aufgebraucht.
          {stats.searchErrors.length > 0 && (
            <div style={{ marginTop: 4, color: "var(--muted)" }}>Details: {stats.searchErrors.slice(0, 3).join(" · ")}</div>
          )}
        </div>
      )}

      <div className="report-grid">
        <section className="panel doc-view">
          <DistributionBar report={report} textLength={text.length} onPick={focusSegment} />
          <div className="legend">
            {FILTER_KINDS.map((k) => {
              const off = hidden.includes(k);
              return (
                <button
                  key={k}
                  className={`legend-item ${off ? "off" : ""}`}
                  aria-pressed={!off}
                  title={off ? "Einblenden" : "Ausblenden"}
                  onClick={() => setHidden((h) => (h.includes(k) ? h.filter((x) => x !== k) : [...h, k]))}
                >
                  <i className={`sw sw-${k}`} /> {k === "exact" ? "Wörtlich" : k === "near" ? "Leicht verändert" : k === "paraphrase" ? "Paraphrase" : "Zitat"}
                </button>
              );
            })}
            {report.excludedWords > 0 && (
              <span className="legend-item static">
                <i className="sw sw-excluded" /> Nicht geprüft
              </span>
            )}
            <span className="legend-hint">Farbe = Quelle · Klick auf eine Markierung zeigt den Vergleich</span>
          </div>
          <div className="doc-text">
            {report.segments.map((seg, i) => {
              const chunk = text.slice(seg.start, seg.end);
              if (seg.kind === "excluded") {
                return (
                  <span key={i} className="excluded" title="Nicht geprüft">
                    {chunk}
                  </span>
                );
              }
              if (seg.sourceIdx === undefined || !seg.kind || hidden.includes(seg.kind)) return <span key={i}>{chunk}</span>;
              const sr = report.sources[seg.sourceIdx];
              const isActive = active && active.s === seg.sourceIdx && active.m === seg.matchIdx;
              const dim = selectedIdx !== null && selectedIdx !== seg.sourceIdx;
              return (
                <mark
                  key={i}
                  id={`seg-${i}`}
                  className={`hl ${seg.kind} ${dim ? "dim" : ""} ${isActive ? "active" : ""}`}
                  style={{ "--h": hueFor(sr.color) } as CSSProperties}
                  title={`${KIND_LABEL[seg.kind]} – ${sr.source.title}`}
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
          {active && report.sources[active.s]?.matches[active.m] && (
            <Detail
              sr={report.sources[active.s]}
              match={report.sources[active.s].matches[active.m]}
              text={text}
              tokens={tokens}
              kind={
                report.segments.find((s) => s.sourceIdx === active.s && s.matchIdx === active.m)?.kind ??
                report.sources[active.s].matches[active.m].type
              }
              count={segmentsBySource.get(active.s)?.length ?? 0}
              onClose={() => setActive(null)}
              onStep={step}
              onIgnore={() => {
                update({ ignoredRanges: [...adj.ignoredRanges, matchRange(tokens, report.sources[active.s].matches[active.m])] });
                setActive(null);
              }}
              onCite={() => {
                update({ citedRanges: [...adj.citedRanges, matchRange(tokens, report.sources[active.s].matches[active.m])] });
              }}
              onSynopsis={() => setSynopsis(active.s)}
            />
          )}
          <section className="panel sources">
            <h2 style={{ padding: "0 8px" }}>Gefundene Quellen</h2>
            {report.sources.length === 0 && <div className="empty">Es wurden keine übereinstimmenden Quellen gefunden.</div>}
            {report.sources.map((sr, idx) => (
              <SourceItem
                key={sr.source.id}
                sr={sr}
                selected={selectedIdx === idx}
                count={segmentsBySource.get(idx)?.length ?? 0}
                onSelect={() => selectSource(idx)}
                onSynopsis={() => setSynopsis(idx)}
                onToggleCited={() => update({ citedSources: toggle(adj.citedSources, sr.source.id) })}
                onIgnore={() => {
                  update({ ignoredSources: [...adj.ignoredSources, sr.source.id] });
                  if (selected === sr.source.id) setSelected(null);
                  setActive(null);
                }}
              />
            ))}

            {(report.ignoredSources.length > 0 || adj.ignoredRanges.length > 0 || adj.citedRanges.length > 0) && (
              <div className="ignored-box no-print">
                <button className="inline-link" onClick={() => setShowIgnored((x) => !x)}>
                  {showIgnored ? "▾" : "▸"} Ignoriert / manuell angepasst (
                  {report.ignoredSources.length + adj.ignoredRanges.length + adj.citedRanges.length})
                </button>
                {showIgnored && (
                  <ul>
                    {report.ignoredSources.map((ms) => (
                      <li key={ms.source.id}>
                        <span>Quelle: {ms.source.title || domainOf(ms.source.url)}</span>
                        <button className="inline-link" onClick={() => update({ ignoredSources: adj.ignoredSources.filter((x) => x !== ms.source.id) })}>
                          wiederherstellen
                        </button>
                      </li>
                    ))}
                    {adj.ignoredRanges.map((r, i) => (
                      <li key={`i${i}`}>
                        <span>Ignoriert: „{shorten(text.slice(r[0], r[1]))}“</span>
                        <button className="inline-link" onClick={() => update({ ignoredRanges: adj.ignoredRanges.filter((_, j) => j !== i) })}>
                          wiederherstellen
                        </button>
                      </li>
                    ))}
                    {adj.citedRanges.map((r, i) => (
                      <li key={`c${i}`}>
                        <span>Als Zitat: „{shorten(text.slice(r[0], r[1]))}“</span>
                        <button className="inline-link" onClick={() => update({ citedRanges: adj.citedRanges.filter((_, j) => j !== i) })}>
                          rückgängig
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </aside>
      </div>

      {synopsis !== null && report.sources[synopsis] && (
        <Synopsis
          text={text}
          report={report}
          sourceIdx={synopsis}
          hue={hueFor(report.sources[synopsis].color)}
          onClose={() => setSynopsis(null)}
        />
      )}
    </>
  );
}

function shorten(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function DistributionBar({ report, textLength, onPick }: { report: Report; textLength: number; onPick: (seg: number) => void }) {
  if (!textLength) return null;
  return (
    <div className="dist no-print-break">
      <div className="dist-label">Verteilung im Dokument</div>
      <div className="dist-bar" role="img" aria-label="Verteilung der Übereinstimmungen im Dokument">
        {report.segments.map((seg, i) => {
          if (!seg.kind) return null;
          const left = (seg.start / textLength) * 100;
          const width = Math.max(0.5, ((seg.end - seg.start) / textLength) * 100);
          const style: CSSProperties & Record<string, string | number> = { left: `${left}%`, width: `${width}%` };
          if (seg.sourceIdx !== undefined) style["--h"] = hueFor(report.sources[seg.sourceIdx].color);
          return (
            <span
              key={i}
              className={`dist-seg ${seg.kind}`}
              style={style}
              onClick={() => seg.sourceIdx !== undefined && onPick(i)}
              title={seg.sourceIdx !== undefined ? report.sources[seg.sourceIdx].source.title : "Nicht geprüft"}
            />
          );
        })}
      </div>
    </div>
  );
}

interface SourceItemProps {
  sr: SourceReport;
  selected: boolean;
  count: number;
  onSelect: () => void;
  onSynopsis: () => void;
  onToggleCited: () => void;
  onIgnore: () => void;
}

function SourceItem({ sr, selected, count, onSelect, onSynopsis, onToggleCited, onIgnore }: SourceItemProps) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div className={`source-item ${selected ? "selected" : ""}`} style={{ "--h": hueFor(sr.color) } as CSSProperties} onClick={onSelect}>
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
        {(sr.mentioned || sr.cited) && (
          <div className="source-flags">
            {sr.mentioned && <span className="badge badge-good" title="Domain, DOI oder Titel der Quelle kommt im Text vor">✓ im Text/Literaturverzeichnis genannt</span>}
            {sr.cited && <span className="badge badge-good">als korrekt zitiert gewertet</span>}
          </div>
        )}
        <div className="print-only" style={{ fontSize: 11, wordBreak: "break-all" }}>
          {sr.source.url}
        </div>
        <div className="source-actions no-print">
          <button onClick={stop(onSynopsis)} title="Text und Quelle nebeneinander anzeigen">
            Synopse
          </button>
          <button onClick={stop(onToggleCited)} title="Alle Stellen dieser Quelle als korrekt zitiert werten">
            {sr.cited ? "Nicht mehr als zitiert" : "Als zitiert werten"}
          </button>
          <button onClick={stop(onIgnore)} title="Quelle aus dem Bericht entfernen">
            Ignorieren
          </button>
        </div>
      </div>
      <div className="source-pct">
        {fmt(sr.exclusivePercent)} %<small>{count} Stellen</small>
        {sr.citedWords > 0 && <small>{fmt((sr.citedWords / Math.max(1, sr.words)) * 100)} % zitiert</small>}
      </div>
    </div>
  );
}

interface DetailProps {
  sr: SourceReport;
  match: Match;
  text: string;
  tokens: Token[];
  kind: SegmentKind;
  count: number;
  onClose: () => void;
  onStep: (dir: 1 | -1) => void;
  onIgnore: () => void;
  onCite: () => void;
  onSynopsis: () => void;
}

function Detail({ sr, match, text, tokens, kind, count, onClose, onStep, onIgnore, onCite, onSynopsis }: DetailProps) {
  const docStart = tokens[match.t0].s;
  const docEnd = tokens[match.t1 - 1].e;
  const docPart = text.slice(docStart, docEnd);
  const srcText = sr.source.text;
  const ctxBefore = srcText.slice(Math.max(0, match.srcStart - 140), match.srcStart);
  const ctxAfter = srcText.slice(match.srcEnd, match.srcEnd + 140);
  const srcPart = srcText.slice(match.srcStart, match.srcEnd);

  const docWords = new Set(tokenize(docPart).map((t) => t.w));
  const srcWords = new Set(tokenize(srcPart).map((t) => t.w));

  return (
    <section id="match-detail" className="panel detail" style={{ "--h": hueFor(sr.color) } as CSSProperties}>
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
      <div className="detail-actions">
        <button className="btn btn-sm" onClick={onIgnore} title="Diese Stelle ist unbedenklich und wird nicht gewertet">
          Stelle ignorieren
        </button>
        {kind !== "citation" && (
          <button className="btn btn-sm" onClick={onCite} title="Diese Stelle ist korrekt zitiert">
            Als Zitat werten
          </button>
        )}
        <button className="btn btn-sm" onClick={onSynopsis}>
          Synopse
        </button>
      </div>
      {count > 1 && (
        <div className="detail-actions" style={{ marginTop: 8 }}>
          <button className="btn btn-sm" onClick={() => onStep(-1)}>
            ← Vorherige
          </button>
          <button className="btn btn-sm" onClick={() => onStep(1)}>
            Nächste →
          </button>
        </div>
      )}
    </section>
  );
}

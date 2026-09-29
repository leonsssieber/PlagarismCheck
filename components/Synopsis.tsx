"use client";

import { useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import type { Report } from "@/lib/compare";
import { KIND_LABEL, domainOf } from "./shared";

interface Props {
  text: string;
  report: Report;
  sourceIdx: number;
  hue: number;
  onClose: () => void;
}

/** Side-by-side view of the checked text and the complete source ("Synopse"). */
export default function Synopsis({ text, report, sourceIdx, hue, onClose }: Props) {
  const sr = report.sources[sourceIdx];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Matches of this source that are visible in the report
  const visible = useMemo(() => {
    const set = new Set<number>();
    for (const seg of report.segments) if (seg.sourceIdx === sourceIdx && seg.matchIdx !== undefined) set.add(seg.matchIdx);
    return set;
  }, [report, sourceIdx]);

  const left = useMemo(() => {
    const out: ReactNode[] = [];
    const seen = new Set<number>();
    report.segments.forEach((seg, i) => {
      const chunk = text.slice(seg.start, seg.end);
      if (seg.sourceIdx !== sourceIdx || seg.matchIdx === undefined || !seg.kind) {
        out.push(<span key={i}>{chunk}</span>);
        return;
      }
      const first = !seen.has(seg.matchIdx);
      seen.add(seg.matchIdx);
      const mi = seg.matchIdx;
      out.push(
        <mark
          key={i}
          id={first ? `syn-d-${mi}` : undefined}
          className={`hl ${seg.kind}`}
          title={KIND_LABEL[seg.kind]}
          onClick={() => document.getElementById(`syn-s-${mi}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
        >
          {chunk}
        </mark>,
      );
    });
    return out;
  }, [report, sourceIdx, text]);

  const right = useMemo(() => {
    const src = sr.source.text;
    const ranges = sr.matches
      .map((m, mi) => ({ s: m.srcStart, e: m.srcEnd, mi, type: m.type }))
      .filter((r) => visible.has(r.mi))
      .sort((a, b) => a.s - b.s);
    const out: ReactNode[] = [];
    let pos = 0;
    for (const r of ranges) {
      const s = Math.max(r.s, pos);
      if (r.e <= s) continue;
      if (s > pos) out.push(<span key={`t${pos}`}>{src.slice(pos, s)}</span>);
      out.push(
        <mark
          key={`m${r.mi}`}
          id={`syn-s-${r.mi}`}
          className={`hl ${r.type}`}
          onClick={() => document.getElementById(`syn-d-${r.mi}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}
        >
          {src.slice(s, r.e)}
        </mark>,
      );
      pos = r.e;
    }
    if (pos < src.length) out.push(<span key="end">{src.slice(pos)}</span>);
    return out;
  }, [sr, visible]);

  useEffect(() => {
    // Jump to the first match in the source
    const first = [...visible].sort((a, b) => sr.matches[a].srcStart - sr.matches[b].srcStart)[0];
    if (first !== undefined) setTimeout(() => document.getElementById(`syn-s-${first}`)?.scrollIntoView({ block: "center" }), 30);
  }, [sr, visible]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel" style={{ "--h": hue } as CSSProperties} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Synopse">
        <div className="modal-head">
          <div style={{ minWidth: 0 }}>
            <strong>Synopse</strong> · {sr.source.title}
            {sr.source.url && (
              <>
                {" "}
                ·{" "}
                <a href={sr.source.url} target="_blank" rel="noreferrer noopener">
                  {domainOf(sr.source.url)} ↗
                </a>
              </>
            )}
          </div>
          <button className="btn btn-sm" onClick={onClose} aria-label="Schließen">
            ✕
          </button>
        </div>
        <div className="modal-hint">Klick auf eine Markierung springt zur entsprechenden Stelle auf der anderen Seite.</div>
        <div className="synopsis">
          <div className="syn-col">
            <div className="syn-title">Dein Text</div>
            <div className="syn-text">{left}</div>
          </div>
          <div className="syn-col">
            <div className="syn-title">Quelle{sr.source.kind === "snippet" ? " (nur Suchmaschinen-Auszug verfügbar)" : ""}</div>
            <div className="syn-text">{right}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

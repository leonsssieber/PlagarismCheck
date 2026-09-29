"use client";

import { useEffect, useRef, useState } from "react";
import ReportView from "@/components/ReportView";
import { ACCEPTED_FILES, fileToText } from "@/lib/client/files";
import { runCheck, type CheckProgress, type CheckResult, type CheckSettings, type Sensitivity } from "@/lib/client/runCheck";
import { DEPTH_SETTINGS, type Depth } from "@/lib/queries";
import { findBibliography, type SourceDoc } from "@/lib/compare";
import { EMPTY_ADJUSTMENTS, deleteEntry, listHistory, loadEntry, saveEntry, type HistorySummary, type UserAdjustments } from "@/lib/client/history";
import { wordCount } from "@/lib/text";

const MIN_WORDS = 30;
const MAX_WORDS = 25_000;
const SETTINGS_KEY = "plagiat-settings-v1";

type Stored = Omit<CheckSettings, "references">;

const DEFAULT_SETTINGS: Stored = {
  depth: "standard",
  web: true,
  wikipedia: true,
  academic: true,
  excludeQuotes: true,
  sensitivity: "normal",
  excludeDomains: [],
  ignoreBibliography: true,
  ignorePhrases: [],
};

export default function Home() {
  const [text, setText] = useState("");
  const [settings, setSettings] = useState<Stored>(DEFAULT_SETTINGS);
  const [references, setReferences] = useState<SourceDoc[]>([]);
  const [progress, setProgress] = useState<CheckProgress | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [adjustments, setAdjustments] = useState<UserAdjustments>(EMPTY_ADJUSTMENTS);
  const [history, setHistory] = useState<HistorySummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [webProviders, setWebProviders] = useState<string[] | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const refInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
    } catch {
      /* ignore */
    }
    listHistory().then(setHistory);
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => setWebProviders(d.webProviders ?? []))
      .catch(() => setWebProviders([]));
  }, []);

  const update = (patch: Partial<Stored>) => {
    setSettings((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const words = wordCount(text);

  async function loadFile(file: File) {
    setError(null);
    setLoadingFile(true);
    try {
      const t = await fileToText(file);
      if (!t.trim()) throw new Error("In der Datei wurde kein Text gefunden (evtl. eingescanntes PDF ohne Texterkennung).");
      setText(t);
    } catch (e) {
      setError(`Datei konnte nicht gelesen werden: ${(e as Error).message}`);
    } finally {
      setLoadingFile(false);
    }
  }

  async function addReferences(files: FileList | null) {
    if (!files) return;
    setError(null);
    for (const f of Array.from(files)) {
      try {
        const t = await fileToText(f);
        setReferences((r) => [...r, { id: `ref-${Date.now()}-${f.name}`, url: "", title: f.name, text: t, kind: "reference", provider: "Eigenes Dokument" }]);
      } catch (e) {
        setError(`${f.name}: ${(e as Error).message}`);
      }
    }
  }

  async function start() {
    setError(null);
    if (words < MIN_WORDS) {
      setError(`Bitte mindestens ${MIN_WORDS} Wörter eingeben.`);
      return;
    }
    if (words > MAX_WORDS) {
      setError(`Der Text ist zu lang (max. ${MAX_WORDS.toLocaleString("de-DE")} Wörter). Bitte in Teilen prüfen.`);
      return;
    }
    if (!settings.web && !settings.wikipedia && !settings.academic && references.length === 0) {
      setError("Bitte mindestens eine Quelle auswählen oder Vergleichsdokumente hochladen.");
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setProgress({ phase: "search", percent: 0, message: "Starte Prüfung…" });
    try {
      const res = await runCheck(text, { ...settings, references }, setProgress, ctrl.signal);
      setAdjustments(EMPTY_ADJUSTMENTS);
      setResult(res);
      window.scrollTo({ top: 0 });
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError(`Die Prüfung ist fehlgeschlagen: ${(e as Error).message}`);
    } finally {
      setProgress(null);
      abortRef.current = null;
    }
  }

  async function openHistory(id: string) {
    const entry = await loadEntry(id);
    if (!entry) {
      setError("Diese Prüfung konnte nicht geladen werden.");
      return;
    }
    setText(entry.result.text);
    setAdjustments(entry.adjustments);
    setResult(entry.result);
    window.scrollTo({ top: 0 });
  }

  async function removeHistory(id: string) {
    await deleteEntry(id);
    setHistory(await listHistory());
  }

  const bibliography = settings.ignoreBibliography && text ? findBibliography(text) : null;

  const webLabel =
    webProviders === null
      ? ""
      : webProviders.filter((p) => p !== "duckduckgo").length
        ? `über ${webProviders.filter((p) => p !== "duckduckgo").map(providerName).join(", ")}`
        : "über DuckDuckGo (ohne API-Schlüssel)";

  return (
    <>
      <header className="topbar">
        <div className="container">
          <div className="logo">
            <div className="logo-mark" aria-hidden>✓</div>
            Plagiatsprüfer
          </div>
          <div className="spacer" />
          <div className="hint">Kostenlos · ohne Anmeldung · Texte werden nicht gespeichert</div>
        </div>
      </header>

      <main>
        <div className="container">
          {result ? (
            <ReportView
              key={result.id}
              result={result}
              adjustments={adjustments}
              onAdjustmentsChange={(adj, report) => {
                const r = result;
                saveEntry({
                  id: r.id,
                  date: r.date,
                  title: r.text.trim().split(/\s+/).slice(0, 12).join(" "),
                  words: report.totalWords,
                  percent: report.percent,
                  result: r,
                  adjustments: adj,
                }).then(() => listHistory().then(setHistory));
              }}
              onNew={() => {
                setResult(null);
                setText("");
              }}
              onEdit={() => setResult(null)}
            />
          ) : progress ? (
            <div className="panel progress-wrap">
              <h2>Prüfung läuft…</h2>
              <div className="progress-bar">
                <div style={{ width: `${progress.percent}%` }} />
              </div>
              <div>{progress.message}</div>
              <div className="steps">
                <span className={progress.phase === "search" ? "on" : ""}>1. Quellen suchen</span>
                <span className={progress.phase === "fetch" ? "on" : ""}>2. Quellen laden</span>
                <span className={progress.phase === "compare" ? "on" : ""}>3. Vergleichen</span>
              </div>
              <div style={{ marginTop: 20 }}>
                <button className="btn btn-sm" onClick={() => abortRef.current?.abort()}>
                  Abbrechen
                </button>
              </div>
            </div>
          ) : (
            <>
              <h1>Text auf Plagiate prüfen</h1>
              <p className="lead">
                Findet wörtliche Übernahmen, leicht veränderte Passagen und Paraphrasen – im Web, auf Wikipedia, in
                wissenschaftlichen Veröffentlichungen und in deinen eigenen Vergleichsdokumenten.
              </p>
              {error && <div className="error-box">{error}</div>}
              <div className="input-grid">
                <div
                  className={`panel editor ${dragging ? "drop-active" : ""}`}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) loadFile(f);
                  }}
                >
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Text hier einfügen oder eine Datei (PDF, Word, TXT) hierher ziehen…"
                    aria-label="Zu prüfender Text"
                    spellCheck={false}
                  />
                  <div className="editor-bar">
                    <span>
                      {words.toLocaleString("de-DE")} Wörter · {text.length.toLocaleString("de-DE")} Zeichen
                    </span>
                    <div className="spacer" />
                    {text && (
                      <button className="btn btn-sm" onClick={() => setText("")}>
                        Leeren
                      </button>
                    )}
                    <button className="btn btn-sm" onClick={() => fileInput.current?.click()} disabled={loadingFile}>
                      {loadingFile ? "Lese Datei…" : "Datei hochladen"}
                    </button>
                    <input
                      ref={fileInput}
                      type="file"
                      accept={ACCEPTED_FILES}
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) loadFile(f);
                        e.target.value = "";
                      }}
                    />
                  </div>
                </div>

                <aside className="panel settings">
                  <button className="btn btn-primary btn-lg" onClick={start} disabled={!text.trim()}>
                    Jetzt prüfen
                  </button>

                  <div>
                    <span className="field-label">Prüftiefe</span>
                    <div className="segmented">
                      {(Object.keys(DEPTH_SETTINGS) as Depth[]).map((d) => (
                        <button key={d} className={settings.depth === d ? "active" : ""} onClick={() => update({ depth: d })}>
                          {DEPTH_SETTINGS[d].label}
                        </button>
                      ))}
                    </div>
                    <div className="help">
                      {DEPTH_SETTINGS[settings.depth].queries} Suchanfragen, bis zu {DEPTH_SETTINGS[settings.depth].sources} Quellen
                      im Detail
                    </div>
                  </div>

                  <div>
                    <span className="field-label">Empfindlichkeit</span>
                    <div className="segmented">
                      {(["low", "normal", "high"] as Sensitivity[]).map((s) => (
                        <button key={s} className={settings.sensitivity === s ? "active" : ""} onClick={() => update({ sensitivity: s })}>
                          {s === "low" ? "Niedrig" : s === "normal" ? "Normal" : "Hoch"}
                        </button>
                      ))}
                    </div>
                    <div className="help">„Hoch“ findet auch kurze Übereinstimmungen, aber mehr Fehlalarme.</div>
                  </div>

                  <div>
                    <span className="field-label">Quellen</span>
                    <label className="check">
                      <input type="checkbox" checked={settings.web} onChange={(e) => update({ web: e.target.checked })} />
                      <span>
                        Internet
                        <small>{webLabel}</small>
                      </span>
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={settings.wikipedia} onChange={(e) => update({ wikipedia: e.target.checked })} />
                      <span>Wikipedia</span>
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={settings.academic} onChange={(e) => update({ academic: e.target.checked })} />
                      <span>
                        Wissenschaftliche Arbeiten
                        <small>Titel &amp; Abstracts aus OpenAlex</small>
                      </span>
                    </label>
                    <label className="check">
                      <input type="checkbox" checked={settings.excludeQuotes} onChange={(e) => update({ excludeQuotes: e.target.checked })} />
                      <span>
                        Zitate in Anführungszeichen nicht werten
                        <small>werden grau als Zitat markiert</small>
                      </span>
                    </label>
                  </div>

                  <div>
                    <span className="field-label">Eigene Vergleichsdokumente</span>
                    <button className="btn btn-sm" onClick={() => refInput.current?.click()}>
                      + Dokumente hinzufügen
                    </button>
                    <input
                      ref={refInput}
                      type="file"
                      accept={ACCEPTED_FILES}
                      multiple
                      hidden
                      onChange={(e) => {
                        addReferences(e.target.files);
                        e.target.value = "";
                      }}
                    />
                    <div className="help">z. B. frühere Arbeiten, Arbeiten von Mitschülern oder Quellen, die nicht online sind.</div>
                    {references.length > 0 && (
                      <ul className="ref-list">
                        {references.map((r) => (
                          <li key={r.id}>
                            <span title={r.title}>{r.title}</span>
                            <small>{wordCount(r.text).toLocaleString("de-DE")} W.</small>
                            <button className="link-btn" aria-label="Entfernen" onClick={() => setReferences((x) => x.filter((y) => y.id !== r.id))}>
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <span className="field-label">Ignorieren</span>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={settings.ignoreBibliography}
                        onChange={(e) => update({ ignoreBibliography: e.target.checked })}
                      />
                      <span>
                        Literaturverzeichnis nicht prüfen
                        <small>
                          {!text
                            ? "wird automatisch erkannt (Überschrift „Literatur“, „Quellen“ …)"
                            : bibliography
                              ? `erkannt: ${text.slice(bibliography[0], bibliography[1]).trim().split(/\s+/).length} Wörter werden übersprungen`
                              : "kein Literaturverzeichnis erkannt"}
                        </small>
                      </span>
                    </label>
                    <label className="field-label" htmlFor="phrases" style={{ marginTop: 10 }}>
                      Textstellen / Phrasen ignorieren
                    </label>
                    <textarea
                      id="phrases"
                      className="text-input"
                      rows={3}
                      placeholder={"Eine pro Zeile, z. B. Aufgabenstellung,\nTitel oder Standardformulierungen"}
                      defaultValue={settings.ignorePhrases.join("\n")}
                      onBlur={(e) => update({ ignorePhrases: e.target.value.split("\n").map((x) => x.trim()).filter(Boolean) })}
                    />
                    <div className="help">Nach der Prüfung kannst du im Bericht außerdem einzelne Stellen oder ganze Quellen ignorieren.</div>
                  </div>

                  <div>
                    <label className="field-label" htmlFor="excl">
                      Domains ausschließen
                    </label>
                    <input
                      id="excl"
                      className="text-input"
                      placeholder="z. B. meine-seite.de, example.org"
                      defaultValue={settings.excludeDomains.join(", ")}
                      onBlur={(e) => update({ excludeDomains: e.target.value.split(/[,\s]+/).filter(Boolean) })}
                    />
                  </div>

                  {webProviders !== null && webProviders.length <= 1 && settings.web && (
                    <div className="info-box">
                      Tipp: Mit einem kostenlosen Such-API-Schlüssel (Brave, Serper oder Google) wird die Websuche
                      deutlich gründlicher. Siehe README.
                    </div>
                  )}
                </aside>
              </div>

              {history.length > 0 && (
                <section className="panel history">
                  <h2>Letzte Prüfungen</h2>
                  <div className="help" style={{ marginTop: -8, marginBottom: 8 }}>Nur in diesem Browser gespeichert.</div>
                  <ul>
                    {history.map((h) => (
                      <li key={h.id}>
                        <button className="history-open" onClick={() => openHistory(h.id)}>
                          <span className={`history-pct ${h.percent >= 30 ? "bad" : h.percent >= 15 ? "warn" : "good"}`}>
                            {h.percent.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %
                          </span>
                          <span className="history-title">{h.title}…</span>
                          <span className="history-meta">
                            {new Date(h.date).toLocaleString("de-DE", { dateStyle: "short", timeStyle: "short" })} ·{" "}
                            {h.words.toLocaleString("de-DE")} Wörter
                          </span>
                        </button>
                        <button className="link-btn" aria-label="Löschen" title="Löschen" onClick={() => removeHistory(h.id)}>
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </main>
      <footer className="footer">
        Hinweis: Eine automatische Prüfung liefert Hinweise, keinen Beweis. Markierte Stellen sollten immer von einem
        Menschen bewertet werden.
      </footer>
    </>
  );
}

function providerName(id: string): string {
  return ({ brave: "Brave", serper: "Google (Serper)", google: "Google", searxng: "SearXNG", duckduckgo: "DuckDuckGo" } as Record<string, string>)[id] ?? id;
}

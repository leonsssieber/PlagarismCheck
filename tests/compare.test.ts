import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleReport, buildReport, compareDocs, findBibliography, findPhrases, matchSources, prepare, sourceMentioned } from "../lib/compare.ts";
import { buildQueries } from "../lib/queries.ts";
import { findQuotedRanges } from "../lib/text.ts";

const SOURCE = `Die Photosynthese ist ein physiologischer Prozess zur Erzeugung von energiereichen Biomolekülen aus energieärmeren Stoffen mithilfe von Lichtenergie. Sie wird von Pflanzen, Algen und einigen Bakterien betrieben. Bei diesem biochemischen Vorgang wird mithilfe von lichtabsorbierenden Farbstoffen, wie Chlorophyll, Lichtenergie in chemische Energie umgewandelt. Diese wird dann unter anderem zum Aufbau energiereicher organischer Verbindungen aus energiearmen anorganischen Stoffen verwendet. Die Photosynthese ist der wichtigste Prozess der Primärproduktion auf der Erde und liefert den Sauerstoff der Atmosphäre.`;

const OTHER = `Der Klimawandel beschreibt die langfristige Veränderung der Temperaturen und Wettermuster. Solche Veränderungen können natürlichen Ursprungs sein, etwa durch Schwankungen der Sonnenaktivität oder große Vulkanausbrüche.`;

test("detects verbatim copy", () => {
  const text = `Einleitung meiner Arbeit über Pflanzen. Die Photosynthese ist ein physiologischer Prozess zur Erzeugung von energiereichen Biomolekülen aus energieärmeren Stoffen mithilfe von Lichtenergie. Ich finde das sehr spannend und schreibe hier eigene Gedanken auf.`;
  const m = compareDocs(prepare(text), prepare(SOURCE));
  assert.equal(m.length, 1);
  assert.equal(m[0].type, "exact");
  assert.ok(m[0].words >= 16);
});

test("detects near copy with small edits", () => {
  const text = `Bei diesem biologischen Vorgang wird mit Hilfe von lichtabsorbierenden Farbstoffen, etwa Chlorophyll, Lichtenergie in chemische Energie umgewandelt und gespeichert.`;
  const m = compareDocs(prepare(text), prepare(SOURCE));
  assert.ok(m.length >= 1, "should find a match");
  assert.ok(m.some((x) => x.type === "near" || x.type === "paraphrase"));
});

test("detects paraphrase with reordered words", () => {
  const text = `Pflanzen, Algen sowie manche Bakterien betreiben Photosynthese. Mithilfe von Lichtenergie erzeugt dieser physiologische Prozess energiereiche Biomoleküle aus energieärmeren Stoffen.`;
  const m = compareDocs(prepare(text), prepare(SOURCE));
  assert.ok(m.some((x) => x.type === "paraphrase"), JSON.stringify(m));
});

test("no false positives on unrelated text", () => {
  const m = compareDocs(prepare(OTHER), prepare(SOURCE));
  assert.equal(m.length, 0);
});

test("report percentages and citations", () => {
  const own = "Das ist ein komplett eigener Satz über ganz andere Dinge wie Fahrräder und Brot.";
  const copied = "Die Photosynthese ist der wichtigste Prozess der Primärproduktion auf der Erde und liefert den Sauerstoff der Atmosphäre.";
  const quoted = `„Sie wird von Pflanzen, Algen und einigen Bakterien betrieben, bei diesem biochemischen Vorgang wird mithilfe von lichtabsorbierenden Farbstoffen gearbeitet.“`;
  const text = `${own} ${copied} ${quoted}`;
  const r = buildReport(text, [
    { id: "a", url: "https://example.org/a", title: "A", text: SOURCE, kind: "web" },
    { id: "b", url: "https://example.org/b", title: "B", text: OTHER, kind: "web" },
  ]);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].source.id, "a");
  assert.ok(r.percent > 30 && r.percent < 70, `percent ${r.percent}`);
  assert.ok(r.citedWords > 5, `cited ${r.citedWords}`);
  const joined = r.segments.map((s) => text.slice(s.start, s.end)).join("");
  assert.equal(joined, text);
});

test("queries are generated", () => {
  const q = buildQueries(prepare(SOURCE + " " + OTHER), 5);
  assert.ok(q.length >= 3 && q.length <= 5);
  for (const x of q) assert.ok(x.split(" ").length >= 7);
});

test("quote detection", () => {
  const r = findQuotedRanges('Er sagte „Hallo Welt“ und dann "noch etwas".');
  assert.equal(r.length, 2);
});

test("user adjustments change the report without re-matching", () => {
  const copied = "Die Photosynthese ist der wichtigste Prozess der Primärproduktion auf der Erde und liefert den Sauerstoff der Atmosphäre.";
  const text = `Das ist ein komplett eigener Satz über ganz andere Dinge wie Fahrräder und Brot. ${copied}`;
  const doc = prepare(text);
  const matched = matchSources(doc, [{ id: "a", url: "https://de.wikipedia.org/wiki/Photosynthese", title: "Photosynthese – Wikipedia", text: SOURCE, kind: "wikipedia" }]);
  const base = assembleReport(doc, matched);
  assert.ok(base.percent > 40);

  const ignoredSrc = assembleReport(doc, matched, { ignoredSources: ["a"] });
  assert.equal(ignoredSrc.percent, 0);
  assert.equal(ignoredSrc.ignoredSources.length, 1);

  const start = text.indexOf(copied);
  const ignoredRange = assembleReport(doc, matched, { ignoredRanges: [[start, text.length]] });
  assert.equal(ignoredRange.percent, 0);

  const cited = assembleReport(doc, matched, { citedSources: ["a"] });
  assert.equal(cited.percent, 0);
  assert.ok(cited.citedWords > 10);
  assert.ok(cited.sources[0].cited);

  const excluded = assembleReport(doc, matched, { excludedRanges: [[start, text.length]] });
  assert.equal(excluded.percent, 0);
  assert.ok(excluded.excludedWords > 10);
  assert.ok(excluded.segments.some((s) => s.kind === "excluded"));
});

test("bibliography detection and phrases", () => {
  const body = "Dies ist der Hauptteil der Arbeit. ".repeat(20);
  const text = `Inhaltsverzeichnis\n1. Einleitung\n\n${body}\n\nLiteraturverzeichnis\nMüller, A. (2020): Ein Buch. Berlin.`;
  const bib = findBibliography(text);
  assert.ok(bib);
  assert.ok(text.slice(bib![0]).startsWith("Literaturverzeichnis"));
  assert.equal(findBibliography(body), null);
  assert.equal(findPhrases("Aufgabe: Erkläre X. Aufgabe: Erkläre Y.", ["aufgabe:"]).length, 2);
});

test("source mentioned in bibliography", () => {
  const src = { id: "x", url: "https://www.example-lexikon.de/artikel/photosynthese", title: "Photosynthese erklärt", text: "", kind: "web" as const };
  assert.ok(sourceMentioned("Quellen: https://example-lexikon.de/artikel/photosynthese (abgerufen 2024)", src));
  assert.ok(!sourceMentioned("Quellen: Müller 2020", src));
});

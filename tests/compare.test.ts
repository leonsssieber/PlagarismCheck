import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, compareDocs, prepare } from "../lib/compare.ts";
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

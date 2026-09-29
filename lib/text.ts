// Text utilities: normalisation, tokenisation with character offsets,
// sentence splitting, stop words and a light-weight stemmer.

export interface Token {
  /** normalised word used for matching */
  w: string;
  /** start offset (inclusive) in the original text */
  s: number;
  /** end offset (exclusive) in the original text */
  e: number;
}

export interface Sentence {
  s: number;
  e: number;
  /** index of the first token belonging to the sentence */
  t0: number;
  /** index after the last token belonging to the sentence */
  t1: number;
}

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu;

export function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/['’]/g, "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "");
}

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(WORD_RE)) {
    const start = m.index ?? 0;
    tokens.push({ w: normalizeWord(m[0]), s: start, e: start + m[0].length });
  }
  return tokens;
}

/** Split text into sentences and map them to token ranges. */
export function splitSentences(text: string, tokens: Token[]): Sentence[] {
  const sentences: Sentence[] = [];
  // Sentence end: . ! ? … followed by whitespace + uppercase/quote/digit, or line breaks.
  const boundary = /([.!?…]+["”“»«']?)(\s+)(?=[\p{Lu}\p{N}"„“«»(\[])|\n\s*\n|\n(?=\s*[-•*\d\p{Lu}])/gu;
  let start = 0;
  const ends: number[] = [];
  for (const m of text.matchAll(boundary)) {
    const idx = (m.index ?? 0) + (m[1] ? m[1].length : m[0].length);
    // Avoid splitting after common abbreviations ("z. B.", "Dr.", "vgl.", "e.g.")
    const before = text.slice(Math.max(0, (m.index ?? 0) - 6), (m.index ?? 0) + 1);
    if (m[1] === "." && /(?:\b[a-zA-Z]\.[a-zA-Z]|\b(?:bzw|vgl|ggf|usw|etc|Dr|Prof|Nr|Abb|Kap|S|z|ca|bspw|evtl|inkl|e\.g|i\.e|Fig|al|vs|No|Mr|Mrs|Ms|St))\.$/.test(before)) {
      continue;
    }
    ends.push(idx);
  }
  ends.push(text.length);
  let ti = 0;
  for (const end of ends) {
    if (end <= start) continue;
    const t0 = ti;
    while (ti < tokens.length && tokens[ti].s < end) ti++;
    if (ti > t0) sentences.push({ s: tokens[t0].s, e: tokens[ti - 1].e, t0, t1: ti });
    start = end;
  }
  return sentences;
}

const STOP_DE = `aber alle allem allen aller alles als also am an ander andere anderem anderen anderer anderes auch auf aus bei bin bis bist da damit dann das dass dasselbe dazu dein deine dem den denn der des dessen dich die dies diese diesem diesen dieser dieses dir doch dort du durch ein eine einem einen einer eines einig einige einigem einigen einiger einiges einmal er es etwas euch euer eure für gegen gewesen hab habe haben hat hatte hatten hier hin hinter ich ihm ihn ihnen ihr ihre ihrem ihren ihrer ihres im in indem ins ist jede jedem jeden jeder jedes jene jenem jenen jener jenes jetzt kann kein keine keinem keinen keiner keines können könnte machen man manche manchem manchen mancher manches mein meine mich mir mit muss musste nach nicht nichts noch nun nur ob oder ohne sehr sein seine seinem seinen seiner seines selbst sich sie sind so solche solchem solchen solcher solches soll sollte sondern sonst über um und uns unsere unter viel vom von vor während war waren warst was weg weil weiter welche welchem welchen welcher welches wenn werde werden wie wieder will wir wird wirst wo wollen wollte würde würden zu zum zur zwar zwischen sowie bzw zb wurde wurden worden kann können dabei daher jedoch somit ebenfalls bereits`;
const STOP_EN = `a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not now of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also however thus therefore may might must shall one two`;

export const STOP_WORDS = new Set(
  (STOP_DE + " " + STOP_EN).split(/\s+/).filter(Boolean).map(normalizeWord),
);

export function isStopWord(w: string): boolean {
  return STOP_WORDS.has(w);
}

/** Very small language-agnostic stemmer (German/English suffix stripping + truncation). */
export function stem(w: string): string {
  let s = w;
  if (s.length > 5) {
    s = s.replace(/(?:ungen|heiten|keiten|ischen|ation|ations|ments|ment|ness|ing|ern|ung|heit|keit|isch|lich|ies|es|en|er|em|e|s|ed|ly)$/, "");
  }
  return s.slice(0, 7);
}

export function wordCount(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD_RE)) n++;
  return n;
}

export type Lang = "de" | "en" | "other";

export function detectLanguage(tokens: Token[]): Lang {
  const de = new Set(["der", "die", "und", "ist", "nicht", "das", "ein", "eine", "mit", "sich", "auf", "dass", "werden", "wird", "auch"]);
  const en = new Set(["the", "and", "is", "of", "to", "that", "with", "for", "are", "this", "was", "which", "be", "not", "it"]);
  let d = 0;
  let e = 0;
  for (const t of tokens.slice(0, 3000)) {
    if (de.has(t.w)) d++;
    if (en.has(t.w)) e++;
  }
  if (d === 0 && e === 0) return "other";
  return d >= e ? "de" : "en";
}

/** Returns character ranges [start, end) that are enclosed in quotation marks. */
export function findQuotedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const pairs: Array<[string, string]> = [
    ["„", "“"],
    ["„", "”"],
    ["“", "”"],
    ["»", "«"],
    ["«", "»"],
    ['"', '"'],
  ];
  const taken: boolean[] = new Array(text.length).fill(false);
  for (const [open, close] of pairs) {
    let i = 0;
    while (i < text.length) {
      const a = text.indexOf(open, i);
      if (a < 0) break;
      const b = text.indexOf(close, a + 1);
      if (b < 0) break;
      // Ignore absurdly long "quotes" (probably unbalanced marks)
      if (b - a < 2500 && !taken[a] && !taken[b]) {
        ranges.push([a, b + 1]);
        for (let k = a; k <= b; k++) taken[k] = true;
        i = b + 1;
      } else {
        i = a + 1;
      }
    }
  }
  return ranges.sort((x, y) => x[0] - y[0]);
}

// Search providers used to discover candidate sources. All run server-side.

import * as cheerio from "cheerio";

export interface SearchHit {
  url: string;
  title: string;
  snippet: string;
  provider: string;
  kind: "web" | "wikipedia" | "academic";
  /** full text if the provider already delivers it (e.g. abstracts) */
  text?: string;
}

export type ProviderId = "brave" | "serper" | "google" | "searxng" | "duckduckgo" | "wikipedia" | "openalex";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";

const TIMEOUT = 10_000;

async function getJson(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT), cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export function configuredWebProviders(): ProviderId[] {
  const list: ProviderId[] = [];
  if (process.env.BRAVE_API_KEY) list.push("brave");
  if (process.env.SERPER_API_KEY) list.push("serper");
  if (process.env.GOOGLE_API_KEY && process.env.GOOGLE_CSE_ID) list.push("google");
  if (process.env.SEARXNG_URL) list.push("searxng");
  list.push("duckduckgo");
  return list;
}

async function brave(q: string, lang: string): Promise<SearchHit[]> {
  const params = new URLSearchParams({ q, count: "10" });
  if (lang === "de" || lang === "en") params.set("search_lang", lang);
  const data = await getJson(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_API_KEY! },
  });
  return (data.web?.results ?? []).map((r: any) => ({
    url: r.url,
    title: r.title ?? "",
    snippet: stripTags(r.description ?? ""),
    provider: "Brave",
    kind: "web" as const,
  }));
}

async function serper(q: string, lang: string): Promise<SearchHit[]> {
  const body: Record<string, unknown> = { q, num: 10 };
  if (lang === "de") Object.assign(body, { gl: "de", hl: "de" });
  const data = await getJson("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": process.env.SERPER_API_KEY!, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return (data.organic ?? []).map((r: any) => ({
    url: r.link,
    title: r.title ?? "",
    snippet: r.snippet ?? "",
    provider: "Google (Serper)",
    kind: "web" as const,
  }));
}

async function google(q: string, lang: string): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    key: process.env.GOOGLE_API_KEY!,
    cx: process.env.GOOGLE_CSE_ID!,
    q,
    num: "10",
  });
  if (lang === "de" || lang === "en") params.set("lr", `lang_${lang}`);
  const data = await getJson(`https://www.googleapis.com/customsearch/v1?${params}`);
  return (data.items ?? []).map((r: any) => ({
    url: r.link,
    title: r.title ?? "",
    snippet: r.snippet ?? "",
    provider: "Google",
    kind: "web" as const,
  }));
}

async function searxng(q: string, lang: string): Promise<SearchHit[]> {
  const base = process.env.SEARXNG_URL!.replace(/\/+$/, "");
  const params = new URLSearchParams({ q, format: "json" });
  if (lang === "de" || lang === "en") params.set("language", lang);
  const data = await getJson(`${base}/search?${params}`, { headers: { Accept: "application/json" } });
  return (data.results ?? []).slice(0, 10).map((r: any) => ({
    url: r.url,
    title: r.title ?? "",
    snippet: r.content ?? "",
    provider: "SearXNG",
    kind: "web" as const,
  }));
}

function decodeDdgUrl(href: string): string | null {
  if (!href) return null;
  try {
    const u = new URL(href, "https://duckduckgo.com");
    const target = u.searchParams.get("uddg");
    if (target) return target;
    if (u.hostname.endsWith("duckduckgo.com")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function duckduckgo(q: string, lang: string): Promise<SearchHit[]> {
  const kl = lang === "de" ? "de-de" : lang === "en" ? "us-en" : "wt-wt";
  const headers = {
    "User-Agent": BROWSER_UA,
    "Accept-Language": lang === "de" ? "de-DE,de;q=0.9,en;q=0.8" : "en-US,en;q=0.9",
    "Content-Type": "application/x-www-form-urlencoded",
  };
  const hits: SearchHit[] = [];
  try {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers,
      body: new URLSearchParams({ q, kl }).toString(),
      signal: AbortSignal.timeout(TIMEOUT),
      cache: "no-store",
    });
    if (res.ok) {
      const $ = cheerio.load(await res.text());
      $(".result").each((_, el) => {
        const a = $(el).find("a.result__a").first();
        const url = decodeDdgUrl(a.attr("href") ?? "");
        if (!url || url.includes("duckduckgo.com/y.js")) return;
        hits.push({
          url,
          title: a.text().trim(),
          snippet: $(el).find(".result__snippet").text().trim(),
          provider: "DuckDuckGo",
          kind: "web",
        });
      });
    }
  } catch {
    /* fall through to lite version */
  }
  if (hits.length) return hits;

  const res = await fetch(`https://lite.duckduckgo.com/lite/?${new URLSearchParams({ q, kl })}`, {
    headers,
    signal: AbortSignal.timeout(TIMEOUT),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`DuckDuckGo ${res.status}`);
  const $ = cheerio.load(await res.text());
  $("a.result-link").each((_, el) => {
    const url = decodeDdgUrl($(el).attr("href") ?? "");
    if (!url) return;
    const snippet = $(el).closest("tr").nextAll("tr").first().find(".result-snippet").text().trim();
    hits.push({ url, title: $(el).text().trim(), snippet, provider: "DuckDuckGo", kind: "web" });
  });
  return hits;
}

async function wikipedia(q: string, lang: string): Promise<SearchHit[]> {
  const wl = lang === "en" ? "en" : lang === "de" ? "de" : "en";
  const params = new URLSearchParams({
    action: "query",
    list: "search",
    srsearch: q,
    srlimit: "3",
    format: "json",
    utf8: "1",
  });
  const data = await getJson(`https://${wl}.wikipedia.org/w/api.php?${params}`, {
    headers: { "User-Agent": "Plagiatspruefer/1.0 (open source plagiarism checker)" },
  });
  return (data.query?.search ?? []).map((r: any) => ({
    url: `https://${wl}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, "_"))}`,
    title: `${r.title} – Wikipedia`,
    snippet: stripTags(r.snippet ?? ""),
    provider: "Wikipedia",
    kind: "wikipedia" as const,
  }));
}

function invertedIndexToText(inv: Record<string, number[]> | null | undefined): string {
  if (!inv) return "";
  const words: string[] = [];
  for (const [word, positions] of Object.entries(inv)) for (const p of positions) words[p] = word;
  return words.filter(Boolean).join(" ");
}

async function openalex(q: string): Promise<SearchHit[]> {
  const params = new URLSearchParams({
    search: q,
    per_page: "3",
    select: "id,doi,title,abstract_inverted_index,primary_location,publication_year",
  });
  if (process.env.OPENALEX_MAILTO) params.set("mailto", process.env.OPENALEX_MAILTO);
  const data = await getJson(`https://api.openalex.org/works?${params}`);
  const out: SearchHit[] = [];
  for (const w of data.results ?? []) {
    const abstract = invertedIndexToText(w.abstract_inverted_index);
    if (!abstract) continue;
    const url = w.doi || w.primary_location?.landing_page_url || w.id;
    out.push({
      url,
      title: `${w.title ?? "Ohne Titel"}${w.publication_year ? ` (${w.publication_year})` : ""}`,
      snippet: abstract.slice(0, 240),
      provider: "OpenAlex",
      kind: "academic",
      text: `${w.title ?? ""}. ${abstract}`,
    });
  }
  return out;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'");
}

export async function runProvider(id: ProviderId, q: string, lang: string): Promise<SearchHit[]> {
  switch (id) {
    case "brave":
      return brave(q, lang);
    case "serper":
      return serper(q, lang);
    case "google":
      return google(q, lang);
    case "searxng":
      return searxng(q, lang);
    case "duckduckgo":
      return duckduckgo(q, lang);
    case "wikipedia":
      return wikipedia(q, lang);
    case "openalex":
      return openalex(q);
  }
}

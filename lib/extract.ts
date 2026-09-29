// Server-side retrieval and text extraction of candidate sources.

import * as cheerio from "cheerio";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { BROWSER_UA } from "./search/providers.ts";

const MAX_BYTES = 6 * 1024 * 1024;
const MAX_CHARS = 400_000;

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateIp(v6.slice(7));
  return v6 === "::" || v6 === "::1" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80");
}

async function assertPublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Nur http/https erlaubt");
  if (url.username || url.password) throw new Error("Ungültige URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Nicht erlaubt");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error("Nicht erlaubt");
  return url;
}

async function readLimited(res: Response): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(total, MAX_BYTES));
  let off = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, Math.min(c.byteLength, out.byteLength - off)), off);
    off += c.byteLength;
    if (off >= out.byteLength) break;
  }
  return out;
}

export function htmlToText(html: string): { title: string; text: string } {
  const $ = cheerio.load(html);
  const title = ($("meta[property='og:title']").attr("content") || $("title").first().text() || "").trim();
  $(
    "script,style,noscript,svg,iframe,template,form,button,select,nav,header,footer,aside,[role=navigation],[role=banner],[role=contentinfo],[aria-hidden=true],.cookie,.cookies,#cookie-banner,.advert,.ads,.sidebar,.comments,#comments,.mw-editsection,.reference,sup.reference",
  ).remove();
  $("br").replaceWith("\n");
  $("p,div,li,h1,h2,h3,h4,h5,h6,tr,td,th,section,article,blockquote,dd,dt,pre,figcaption").each((_, el) => {
    $(el).append("\n");
  });

  let root = $("article").first();
  if (!root.length || root.text().trim().length < 800) root = $("main").first();
  if (!root.length || root.text().trim().length < 800) root = $("body");
  const text = root
    .text()
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(bytes);
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join("\n") : text;
}

async function wikipediaText(url: URL): Promise<{ title: string; text: string } | null> {
  const m = url.pathname.match(/^\/wiki\/(.+)$/);
  if (!m) return null;
  const title = decodeURIComponent(m[1]);
  const params = new URLSearchParams({
    action: "query",
    prop: "extracts",
    explaintext: "1",
    titles: title,
    format: "json",
    redirects: "1",
  });
  const res = await fetch(`https://${url.hostname}/w/api.php?${params}`, {
    headers: { "User-Agent": "Plagiatspruefer/1.0 (open source plagiarism checker)" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  const page = Object.values(data.query?.pages ?? {})[0] as any;
  if (!page?.extract) return null;
  return { title: `${page.title} – Wikipedia`, text: page.extract };
}

export async function fetchSource(rawUrl: string): Promise<{ url: string; title: string; text: string }> {
  let url = await assertPublicUrl(rawUrl);

  if (/(^|\.)wikipedia\.org$/.test(url.hostname)) {
    const w = await wikipediaText(url).catch(() => null);
    if (w) return { url: url.toString(), ...w };
  }

  let res: Response | null = null;
  for (let hop = 0; hop < 5; hop++) {
    res = await fetch(url, {
      redirect: "manual",
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
        "Accept-Language": "de-DE,de;q=0.9,en;q=0.8",
      },
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = await assertPublicUrl(new URL(loc, url).toString());
      continue;
    }
    break;
  }
  if (!res) throw new Error("Keine Antwort");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const type = (res.headers.get("content-type") || "").toLowerCase();
  const bytes = await readLimited(res);
  let title = "";
  let text = "";
  if (type.includes("pdf") || url.pathname.toLowerCase().endsWith(".pdf")) {
    text = await pdfToText(bytes);
    title = decodeURIComponent(url.pathname.split("/").pop() || url.hostname);
  } else if (type.includes("html") || type.includes("xml") || type === "") {
    const charset = /charset=([^;]+)/.exec(type)?.[1]?.trim() || "utf-8";
    let html: string;
    try {
      html = new TextDecoder(charset).decode(bytes);
    } catch {
      html = new TextDecoder("utf-8").decode(bytes);
    }
    ({ title, text } = htmlToText(html));
  } else if (type.startsWith("text/")) {
    text = new TextDecoder("utf-8").decode(bytes);
  } else {
    throw new Error(`Nicht unterstützter Inhaltstyp: ${type}`);
  }
  return { url: url.toString(), title: title || url.hostname, text: text.slice(0, MAX_CHARS) };
}

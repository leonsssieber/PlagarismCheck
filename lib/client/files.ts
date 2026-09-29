// Extracts plain text from uploaded files, entirely in the browser.

export const ACCEPTED_FILES = ".txt,.md,.pdf,.docx,.html,.htm,.rtf";

export async function fileToText(file: File): Promise<string> {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(await file.arrayBuffer()));
    const { text } = await extractText(pdf, { mergePages: true });
    return cleanup(Array.isArray(text) ? text.join("\n") : text);
  }
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return cleanup(value);
  }
  if (name.endsWith(".html") || name.endsWith(".htm")) {
    const doc = new DOMParser().parseFromString(await file.text(), "text/html");
    doc.querySelectorAll("script,style,noscript").forEach((el) => el.remove());
    return cleanup(doc.body?.innerText ?? doc.body?.textContent ?? "");
  }
  if (name.endsWith(".rtf")) {
    const raw = await file.text();
    return cleanup(
      raw
        .replace(/\\par[d]?/g, "\n")
        .replace(/\{\*?\\[^{}]+}|[{}]|\\\n?[A-Za-z]+\n?(?:-?\d+)?[ ]?/g, "")
        .replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))),
    );
  }
  if (name.endsWith(".doc")) {
    throw new Error("Alte .doc-Dateien werden nicht unterstützt – bitte als .docx oder PDF speichern.");
  }
  return cleanup(await file.text());
}

function cleanup(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // re-join words hyphenated across line breaks (common in PDFs)
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

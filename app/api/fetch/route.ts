import { NextResponse } from "next/server";
import { fetchSource } from "@/lib/extract";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  let url: unknown;
  try {
    ({ url } = await req.json());
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }
  if (typeof url !== "string") return NextResponse.json({ error: "URL fehlt" }, { status: 400 });
  try {
    const result = await fetchSource(url);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message || "Fehler" }, { status: 502 });
  }
}

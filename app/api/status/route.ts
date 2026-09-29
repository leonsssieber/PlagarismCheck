import { NextResponse } from "next/server";
import { configuredWebProviders } from "@/lib/search/providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ webProviders: configuredWebProviders() });
}

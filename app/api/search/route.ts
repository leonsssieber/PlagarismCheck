import { NextResponse } from "next/server";
import { configuredWebProviders, runProvider, type ProviderId, type SearchHit } from "@/lib/search/providers";

export const runtime = "nodejs";
export const maxDuration = 60;

interface Body {
  queries: string[];
  lang?: string;
  web?: boolean;
  wikipedia?: boolean;
  academic?: boolean;
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Ungültige Anfrage" }, { status: 400 });
  }
  const queries = (body.queries ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, 8);
  const lang = body.lang ?? "de";

  const webProviders = configuredWebProviders();
  const errors: string[] = [];

  const results = await Promise.all(
    queries.map(async (q) => {
      const hits: SearchHit[] = [];
      const tasks: Promise<void>[] = [];
      const run = async (id: ProviderId) => {
        try {
          hits.push(...(await runProvider(id, q, lang)));
        } catch (e) {
          errors.push(`${id}: ${(e as Error).message}`);
          throw e;
        }
      };
      if (body.web !== false) {
        // Try the configured web providers in order until one returns results.
        tasks.push(
          (async () => {
            for (const id of webProviders) {
              const before = hits.length;
              try {
                await run(id);
              } catch {
                continue;
              }
              if (hits.length > before) break;
            }
          })(),
        );
      }
      if (body.wikipedia !== false) tasks.push(run("wikipedia").catch(() => {}));
      if (body.academic !== false) tasks.push(run("openalex").catch(() => {}));
      await Promise.all(tasks);
      return { query: q, hits };
    }),
  );

  return NextResponse.json({ results, errors: [...new Set(errors)].slice(0, 10) });
}

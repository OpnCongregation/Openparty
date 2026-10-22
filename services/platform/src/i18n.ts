import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Ctx } from "./context.js";

// All user-facing text lives in locales/<lang>.json. No text is written into the code.
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "locales");
const cache = new Map<string, Record<string, string>>();

function table(lang: string): Record<string, string> {
  if (!/^[a-z]{2,3}$/.test(lang)) return {};
  if (!cache.has(lang)) {
    const f = join(dir, `${lang}.json`);
    cache.set(lang, existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : {});
  }
  return cache.get(lang)!;
}

/** The first of the party's launch languages that has a translation file, else the pack's default, else English. */
export function activeLocale(ctx: Ctx): string {
  const wanted = ctx.config.get<string[]>("languages.launch");
  return wanted.find((l) => Object.keys(table(l)).length) ?? ctx.config.pack.defaultLocale ?? "en";
}

/** Look a message up in the active language, falling back to English, and fill {0}, {1}, ... */
export function t(ctx: Ctx, key: string, ...args: (string | number)[]): string {
  const raw = table(activeLocale(ctx))[key] ?? table("en")[key];
  if (raw === undefined) throw new Error(`missing translation key: ${key}`);
  return raw.replace(/\{(\d+)\}/g, (_m, i) => String(args[Number(i)] ?? ""));
}

/** Like t() but tries a more specific key first (e.g. ussd.askId.ng_nin before ussd.askId.default). */
export function tSpecific(ctx: Ctx, key: string, specific: string, ...args: (string | number)[]): string {
  const k = `${key}.${specific}`;
  const has = table(activeLocale(ctx))[k] !== undefined || table("en")[k] !== undefined;
  return t(ctx, has ? k : `${key}.default`, ...args);
}

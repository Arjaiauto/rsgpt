// Lets plain Node run the site's server code from a script (scripts/prep-test.mjs): "@/..." paths, imports without
// a file extension, `server-only` and next/cache. Node strips the TypeScript types itself. Run with
//   node --import ./scripts/register.mjs scripts/prep-test.mjs
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stub = (src) => `data:text/javascript,${encodeURIComponent(src)}`;
const STUBS = {
  "server-only": stub("export {};"),
  "next/cache": stub("export const cacheLife = () => {}; export const cacheTag = () => {};"),
  "next/headers": stub("export const cookies = async () => ({ get: () => undefined }); export const headers = async () => new Headers();"),
  "next/navigation": stub("export const redirect = (to) => { throw new Error('redirect ' + to); };"),
  "next/server": stub("export const connection = async () => {};"),
};

function withExtension(file) {
  for (const candidate of [file, `${file}.ts`, `${file}.tsx`, path.join(file, "index.ts")]) {
    if (path.extname(candidate) && existsSync(candidate)) return pathToFileURL(candidate).href;
  }
  return null;
}

export async function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: STUBS[specifier], shortCircuit: true };
  let file = null;
  if (specifier.startsWith("@/")) file = path.join(root, specifier.slice(2));
  else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) file = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
  const url = file && withExtension(file);
  return url ? { url, shortCircuit: true } : next(specifier, context);
}

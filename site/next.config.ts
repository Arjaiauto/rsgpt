import { existsSync } from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// Locally, secrets live in the project's single .env one folder up (E:\rsgpt\.env); load it for the server only.
// On Vercel that file does not exist and the variables come from the project settings, so this is skipped.
// process.loadEnvFile only adds variables and never removes or overrides ones already set, so it leaves
// alone what Next puts in process.env (for example RUST_MIN_STACK, which Turbopack needs).
// Only variables prefixed NEXT_PUBLIC_ would ever reach the browser, and none are used.
const rootEnv = path.resolve(__dirname, "..", ".env");
try {
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
} catch {
  // An unreadable .env must never stop the build; missing variables fail where they are used.
}

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
        // Nobody may put the site in a frame (clickjacking). This is about OTHER sites framing us; the YouTube player
        // that Cuepoint embeds is unaffected. The referrer policy still sends the site's origin to YouTube, which its
        // embed needs.
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    }];
  },
};

export default nextConfig;

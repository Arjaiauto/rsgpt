import "server-only";
import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

/** Server-only Claude client; reads ANTHROPIC_API_KEY. */
export function claude(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
    client = new Anthropic({ maxRetries: 2, timeout: 60_000 });
  }
  return client;
}

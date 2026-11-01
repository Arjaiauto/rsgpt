/** The kind of device a request came from, and nothing more. The user agent is read, mapped to one of three words and
    dropped; it is never stored or logged. (An iPad that asks for desktop sites sends a Mac user agent and shows as desktop.) */
export type DeviceType = "phone" | "tablet" | "desktop";

export function deviceType(userAgent: string | null | undefined): DeviceType {
  const ua = userAgent ?? "";
  if (/iPad|Tablet|PlayBook|Kindle|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/iPhone|iPod|Android|Mobile|Windows Phone|BlackBerry|Opera Mini/i.test(ua)) return "phone";
  return "desktop";
}

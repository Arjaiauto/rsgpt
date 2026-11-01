// Screenshots for the welcome tour (Ticket 25b), taken from the LIVE site as the test user "tester".
//
//   node scripts/tour-capture.mjs [--force] [--only=ask,prep] [--size=desktop|phone]
//
// Needs playwright-core (not a site dependency): point TOUR_PW_DIR at a folder that has node_modules/playwright-core.
// Uses the installed Chrome (CHROME_PATH or the usual Windows location), never a downloaded browser.
// SITE_PASSWORD comes from ../.env and is never printed. Writes public/tour/<slide>-<d|p>.webp and public/tour/pins.json.
// Resumable: a slide whose two images and pins already exist is skipped unless --force. Network steps retry.
// What it does on the live site as "tester" (flagged is_test, so Insights ignores it): asks one question and builds one
// brief per screen size, saves two clips on the Saved page and removes them again at the end.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const OUT = path.join(root, "public", "tour");
try { process.loadEnvFile(path.resolve(root, "..", ".env")); } catch { /* no .env: SITE_PASSWORD must already be set */ }

const BASE = "https://cuepoint-two.vercel.app";
const NAME = "tester";
const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const ONLY = args.find((a) => a.startsWith("--only="))?.slice(7).split(",") ?? null;
const SIZE = args.find((a) => a.startsWith("--size="))?.slice(7) ?? null;
if (!process.env.SITE_PASSWORD) { console.error("SITE_PASSWORD is not set in ../.env"); process.exit(1); }
if (!process.env.TOUR_PW_DIR) { console.error("Set TOUR_PW_DIR to a folder that contains node_modules/playwright-core"); process.exit(1); }
const { chromium } = createRequire(path.join(process.env.TOUR_PW_DIR, "x.js"))("playwright-core");
// The login (a cookie) is saved here after the first run and reused, so re-runs never spend the login rate limit (10 per
// 15 minutes). It lives outside the repo; delete the file to log in again.
const STATE_DIR = process.env.TOUR_STATE_DIR ?? process.env.TOUR_PW_DIR;
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

const SIZES = {
  desktop: { tag: "d", width: 1440, dpr: 1, mobile: false },
  phone: { tag: "p", width: 390, dpr: 2, mobile: true },
};
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function retry(label, fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries) throw e;
      log(`${label} failed (${String(e.message).split("\n")[0]}), retry ${i}/${tries - 1}`);
      await sleep(2000 * i);
    }
  }
}

/** A pin: n (the callout number), selector, and where on the element the dot sits. */
const pin = (n, selector, at = "tl") => ({ n, selector, at });

/** Each slide: where to go, what to do first, how tall the picture is per size, and where the numbered dots go. */
const SLIDES = [
  {
    id: "welcome", url: "/ask", height: { desktop: 640, phone: 470 },
    async prepare(page, size) { if (size === "phone") { await page.locator("details.menu summary").click(); await sleep(300); } },
    pins: { desktop: [pin(1, "nav.links:visible", "l"), pin(2, ".qs:visible", "tr"), pin(3, ".bar-top .avatar", "tr")],
            phone: [pin(1, ".menu__list:visible", "tl"), pin(2, ".qs:visible", "tr"), pin(3, ".bar-top .avatar", "tr")] },
  },
  {
    id: "ask", url: "/ask", height: { desktop: 1650, phone: 2100 },
    async prepare(page) {
      await page.locator("#ask-first").fill("What have founders said about raising their first round?");
      await page.locator("#ask-first").press("Enter");
      await page.getByRole("button", { name: "Copy answer" }).waitFor({ timeout: 150000 });
      await page.locator(".srcs .src").first().waitFor({ timeout: 20000 });
      await sleep(800);
    },
    pins: { desktop: [pin(1, ".dock .composer", "l"), pin(2, ".ans .cite", "tr"), pin(3, ".srcs", "tl")],
            phone: [pin(1, ".dock .composer", "l"), pin(2, ".ans .cite", "tr"), pin(3, ".srcs", "tl")] },
  },
  {
    id: "prep", url: "/prep", height: { desktop: 1000, phone: 1500 },
    async prepare(page) {
      await page.locator("#prep-name").fill("Nikhil Kamath");
      await page.locator("#prep-desc").fill("Co-founder of Zerodha, investor");
      await page.getByRole("button", { name: "Build brief" }).click();
      await page.locator(".prep-actions").waitFor({ timeout: 180000 });
      await sleep(1000);
    },
    pins: { desktop: [pin(1, "#prep-name", "l"), pin(2, ".prep-form button[type=submit]", "tr"), pin(3, ".prep-actions", "tl")],
            phone: [pin(1, "#prep-name", "l"), pin(2, ".prep-form button[type=submit]", "tr"), pin(3, ".prep-actions", "tl")] },
  },
  {
    id: "guests", url: "/guests", height: { desktop: 900, phone: 900 },
    async prepare(page, size) {
      await page.locator(".gx-card").nth(1).waitFor();
      if (size === "desktop") await page.locator(".gx-card").nth(1).hover();
      else await page.locator(".gx-card .gx-link").first().click(); // the first tap opens the card on touch screens
      await sleep(900);
    },
    pins: { desktop: [pin(1, "#gx-q", "l"), pin(2, "#gx-year", "tr"), pin(3, ".gx-card.open .gx-stats, .gx-card:hover .gx-stats", "tl")],
            phone: [pin(1, "#gx-q", "l"), pin(2, "#gx-year", "tr"), pin(3, ".gx-card.open .gx-stats", "tl")] },
  },
  {
    id: "clips", url: "/clips", height: { desktop: 900, phone: 1000 },
    async prepare(page) { await page.locator(".cl-card").first().waitFor(); await sleep(900); },
    pins: { desktop: [pin(1, "#cl-q", "l"), pin(2, ".cl-card", "tl"), pin(3, ".cl-reelsbtn", "tr")],
            phone: [pin(1, "#cl-q", "l"), pin(2, ".cl-card", "tl"), pin(3, ".cl-reelsbtn", "tr")] },
  },
  {
    id: "saved", url: "/saved", height: { desktop: 860, phone: 1100 },
    // Two clips are saved from /clips first, one gets a folder and a note; everything is removed again afterwards.
    async prepare(page) {
      for (const i of [0, 1]) {
        await page.goto(`${BASE}/clips`, { waitUntil: "networkidle" });
        await page.locator(".cl-card").nth(i).click();
        const save = page.getByRole("button", { name: /^Save$/ }).first();
        await save.waitFor({ timeout: 20000 });
        await save.click();
        await sleep(1200);
      }
      await page.goto(`${BASE}/saved`, { waitUntil: "networkidle" });
      await page.locator(".sv-it").nth(1).waitFor();
      // A folder is made in the side form (hidden on phones, where the folder row just shows "All"). Adding one opens it,
      // so go back to All before filing the first item in it.
      if (await page.locator("#sv-newfolder").isVisible()) {
        await page.locator("#sv-newfolder").fill("Episode ideas");
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await sleep(1000);
        await page.locator(".sv-fd").first().click();
        await sleep(600);
        await page.locator(".sv-fsel").first().selectOption({ label: "Episode ideas" });
        await sleep(1200);
      }
      await page.locator(".sv-note").first().fill("Use this in the intro");
      await page.locator(".sv-note").first().blur();
      await sleep(1500);
    },
    async cleanup(page) {
      await page.goto(`${BASE}/saved`, { waitUntil: "networkidle" });
      for (let i = 0; i < 20 && (await page.locator(".sv-rm").count()); i++) {
        await page.locator(".sv-rm").first().click();
        await sleep(700);
      }
    },
    pins: { desktop: [pin(1, ".sv-tabs", "l"), pin(2, ".sv-folders", "tl"), pin(3, ".sv-note", "tr")],
            phone: [pin(1, ".sv-tabs", "l"), pin(2, ".sv-folders", "tl"), pin(3, ".sv-note", "tr")] },
  },
  {
    id: "insights", url: "/insights", height: { desktop: 1250, phone: 1500 },
    async prepare(page) { await page.locator(".in-tiles").first().waitFor(); await sleep(1200); },
    pins: { desktop: [pin(1, ".in-tiles", "tl"), pin(2, "#in-topics-h", "l"), pin(3, "section[aria-labelledby='in-topics-h'] a:visible", "tl")],
            phone: [pin(1, ".in-tiles", "tl"), pin(2, "#in-topics-h", "l"), pin(3, "section[aria-labelledby='in-topics-h'] a:visible", "tl")] },
  },
];

async function login(page) {
  await retry("login", async () => {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.locator("#fname").fill(NAME);
    await page.locator("#pw").fill(process.env.SITE_PASSWORD);
    await page.getByRole("button", { name: "Enter" }).click();
    await page.waitForURL("**/ask", { timeout: 30000 });
  });
}

const pinPoint = (box, at) => {
  const x = box.x, y = box.y, w = box.width, h = box.height;
  if (at === "c") return { x: x + w / 2, y: y + h / 2 };
  if (at === "l") return { x, y: y + h / 2 }; // centred on the left edge, so it sits beside the text, not on it
  if (at === "tr") return { x: x + w, y }; // centred on the top-right corner: for buttons and chips whose label must stay readable
  return { x: x + Math.min(14, w / 2), y: y + Math.min(14, h / 2) }; // top-left, just inside the corner
};

async function captureSlide(page, slide, sizeName) {
  const size = SIZES[sizeName];
  const height = slide.height[sizeName];
  await page.setViewportSize({ width: size.width, height });
  try {
    await retry(`goto ${slide.url}`, () => page.goto(BASE + slide.url, { waitUntil: "networkidle" }));
    await page.addStyleTag({ content: "*{caret-color:transparent!important}" });
    await slide.prepare?.(page, sizeName);
    // Nobody should see the test name: the top bar says "Hi there".
    await page.evaluate(() => {
      document.querySelectorAll(".hello__name").forEach((e) => { e.textContent = "Hi there"; });
      document.querySelectorAll(".sv-whose b").forEach((e) => { e.textContent = "Your"; }); // Saved says "tester’s saved items"
      document.querySelectorAll(".prep-meta").forEach((e) => { e.textContent = (e.textContent || "").replace(/tester/i, "you"); }); // "prepared for tester"
      document.querySelectorAll(".toasts").forEach((e) => { e.style.display = "none"; }); // "Moved to ..." after a save
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    const pins = [];
    for (const p of slide.pins[sizeName]) {
      const box = await page.locator(p.selector).first().boundingBox({ timeout: 10000 });
      if (!box) throw new Error(`no box for ${p.selector}`);
      const pt = pinPoint(box, p.at);
      if (pt.y < 0 || pt.y > height) throw new Error(`pin ${p.n} (${p.selector}) is outside the picture at y=${Math.round(pt.y)} of ${height}`);
      pins.push({ n: p.n, x: +(pt.x / size.width).toFixed(4), y: +(pt.y / height).toFixed(4) });
    }
    const png = await page.screenshot({ type: "png" });
    const file = `${slide.id}-${size.tag}.webp`;
    const info = await sharp(png).webp({ quality: 80, effort: 5 }).toFile(path.join(OUT, file));
    log(`${file}: ${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KB, pins ${pins.map((p) => `${p.n}@${Math.round(p.x * 100)}%,${Math.round(p.y * 100)}%`).join(" ")}`);
    return { width: info.width, height: info.height, pins };
  } finally {
    try { await slide.cleanup?.(page); } catch (e) { log("cleanup failed:", String(e.message).split("\n")[0]); }
  }
}

mkdirSync(OUT, { recursive: true });
const pinsFile = path.join(OUT, "pins.json");
const pinsAll = existsSync(pinsFile) ? JSON.parse(readFileSync(pinsFile, "utf8")) : {};
const todo = (sizeName) => SLIDES.filter((slide) => {
  if (ONLY && !ONLY.includes(slide.id)) return false;
  const tag = SIZES[sizeName].tag;
  return FORCE || !(existsSync(path.join(OUT, `${slide.id}-${tag}.webp`)) && pinsAll[slide.id]?.[tag]);
});
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
let failed = 0;
try {
  for (const sizeName of Object.keys(SIZES)) {
    if (SIZE && SIZE !== sizeName) continue;
    const slides = todo(sizeName);
    if (!slides.length) { log(`${sizeName}: nothing to do`); continue; }
    const size = SIZES[sizeName];
    // One login per screen size, saved and reused (the login is rate limited: 10 tries per 15 minutes).
    const stateFile = path.join(STATE_DIR, `tour-login-${sizeName}.json`);
    const context = await browser.newContext({
      storageState: existsSync(stateFile) ? stateFile : undefined,
      viewport: { width: size.width, height: 900 }, deviceScaleFactor: size.dpr, isMobile: size.mobile, hasTouch: size.mobile,
      userAgent: size.mobile ? IPHONE : undefined, reducedMotion: "reduce", colorScheme: "dark",
    });
    try {
      const page = await context.newPage();
      // Reuse the saved login if it still works; otherwise log in once and save it.
      await page.goto(`${BASE}/ask`, { waitUntil: "networkidle" });
      if (new URL(page.url()).pathname !== "/ask") await login(page);
      await context.storageState({ path: stateFile });
      for (const slide of slides) {
        try {
          const r = await retry(`${slide.id} ${sizeName}`, () => captureSlide(page, slide, sizeName), 2);
          (pinsAll[slide.id] ??= {})[size.tag] = r;
          writeFileSync(pinsFile, JSON.stringify(pinsAll, null, 1) + "\n");
        } catch (e) {
          failed++;
          console.error(`${slide.id} ${sizeName} FAILED:`, String(e.message).split("\n")[0]);
        }
      }
    } catch (e) {
      failed++;
      console.error(`${sizeName} FAILED:`, String(e.message).split("\n")[0]);
    } finally {
      await context.close().catch(() => {});
    }
  }
} finally {
  await browser.close().catch(() => {});
}
let total = 0;
for (const f of ["welcome", "ask", "prep", "guests", "clips", "saved", "insights"]) for (const t of ["d", "p"]) {
  const p = path.join(OUT, `${f}-${t}.webp`);
  if (existsSync(p)) total += statSync(p).size;
}
log(`done: ${failed} failed, images total ${(total / 1024).toFixed(0)} KB`);
process.exit(failed ? 1 : 0);

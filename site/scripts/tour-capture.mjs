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

/** The part of the page a numbered callout points at: one selector, or several whose boxes are joined (first visible
    match of each). The tour outlines this box and puts the number beside it, so nothing is drawn over the target. */
const pin = (n, ...selectors) => ({ n, selectors });

async function rectOf(page, selectors) {
  let box = null;
  for (const sel of selectors) {
    const b = await page.locator(sel).first().boundingBox({ timeout: 10000 });
    if (!b) throw new Error(`no box for ${sel}`);
    box = box ? { x: Math.min(box.x, b.x), y: Math.min(box.y, b.y), right: Math.max(box.right, b.x + b.width), bottom: Math.max(box.bottom, b.y + b.height) }
              : { x: b.x, y: b.y, right: b.x + b.width, bottom: b.y + b.height };
  }
  return { x: box.x, y: box.y, w: box.right - box.x, h: box.bottom - box.y };
}
const hide = (page, selectors) => page.evaluate((sels) => { for (const s of sels) document.querySelectorAll(s).forEach((e) => { e.style.display = "none"; }); }, selectors);
/** From the top of one part of the page to the bottom of another, across a fixed width. */
const band = async (page, fromSel, toSel, { x, w, padTop = 16, padBottom = 16 }) => {
  const a = await rectOf(page, [fromSel]), b = await rectOf(page, [toSel]);
  const y = Math.max(0, a.y - padTop);
  return { x, y, w, h: b.y + b.h + padBottom - y };
};

/** Each slide: where to go, what to do first, the height of the page when captured, the part kept (crop, in CSS pixels;
    default is the whole page) and what the numbered callouts point at. The pictures are kept as small as they can be
    while still showing every target: the tour fits a slide on one screen without scrolling. */
const SLIDES = [
  {
    id: "welcome", url: "/ask", height: { desktop: 640, phone: 470 },
    async prepare(page, size) { if (size === "phone") { await page.locator("details.menu summary").click(); await sleep(300); } },
    pins: { desktop: [pin(1, "nav.links:visible"), pin(2, ".qs:visible"), pin(3, ".hello", ".logout:visible")],
            phone: [pin(1, ".menu__list:visible"), pin(2, ".qs:visible"), pin(3, ".hello", ".logout:visible")] },
  },
  {
    id: "ask", url: "/ask", height: { desktop: 2000, phone: 2600 },
    async prepare(page, size) {
      await page.locator("#ask-first").fill("What have founders said about raising their first round?");
      await page.locator("#ask-first").press("Enter");
      await page.getByRole("button", { name: "Copy answer" }).waitFor({ timeout: 150000 });
      await page.locator(".srcs .src").first().waitFor({ timeout: 20000 });
      await sleep(800);
      // The big video poster is left out, and the question box sits under the answer instead of floating at the bottom of
      // the window, so the picture is just the answer, its timestamps, the sources and the box.
      await hide(page, [".answer > .card.player", ".ask-new", ".thread .acts", ".ans > p:nth-of-type(n+3)"]); // a long answer shows its first two paragraphs
      await page.addStyleTag({ content: ".dock{position:static!important;background:none!important}.thread{padding-bottom:12px!important}" });
      if (size === "phone") {
        // On a phone the whole answer is a very tall picture: keep the first paragraph (with its timestamps), the sources and
        // the question box, and leave out the question line and the follow-up chips.
        await hide(page, [".q1", ".ans > p:nth-of-type(n+2)", ".after .chips"]);
        await page.evaluate(() => document.querySelectorAll(".after .lbl").forEach((e) => { if ((e.textContent || "").trim().startsWith("Ask next")) e.style.display = "none"; }));
      }
      await sleep(300);
    },
    crop: {
      desktop: (page) => band(page, ".q1", ".dock .composer", { x: 270, w: 900 }),
      phone: (page) => band(page, ".ans", ".dock .composer", { x: 0, w: 390 }),
    },
    pins: { desktop: [pin(1, ".dock .composer"), pin(2, ".ans .cite"), pin(3, ".srcs")],
            phone: [pin(1, ".dock .composer"), pin(2, ".ans .cite"), pin(3, ".srcs")] },
  },
  {
    id: "prep", url: "/prep", height: { desktop: 1000, phone: 2400 },
    async prepare(page, size) {
      await page.locator("#prep-name").fill("Nikhil Kamath");
      await page.locator("#prep-desc").fill("Co-founder of Zerodha, investor");
      await page.getByRole("button", { name: "Build brief" }).click();
      await page.locator(".prep-actions").waitFor({ timeout: 180000 });
      await sleep(1000);
      if (size === "phone") {
        await hide(page, [".prep-past"]); // the empty "Past briefs" box between the form and the brief
        await page.addStyleTag({ content: ".prep-actions{position:static!important}" }); // on a phone this bar sticks to the bottom of the window
      }
    },
    crop: {
      desktop: async (page) => { const f = await rectOf(page, [".prep-form"]); return { x: 100, y: f.y - 24, w: 1240, h: 1000 - (f.y - 24) }; },
      phone: async (page) => { const f = await rectOf(page, [".prep-form"]), a = await rectOf(page, [".prep-actions"]); return { x: 0, y: f.y - 16, w: 390, h: a.y + a.h + 150 - (f.y - 16) }; },
    },
    pins: { desktop: [pin(1, "#prep-name"), pin(2, ".prep-form button[type=submit]"), pin(3, ".prep-actions")],
            phone: [pin(1, "#prep-name"), pin(2, ".prep-form button[type=submit]"), pin(3, ".prep-actions")] },
  },
  {
    id: "guests", url: "/guests", height: { desktop: 900, phone: 1500 },
    async prepare(page, size) {
      await page.locator(".gx-card").nth(1).waitFor();
      if (size === "desktop") await page.locator(".gx-card").nth(1).hover();
      else await page.locator(".gx-card .gx-link").first().click(); // the first tap opens the card on touch screens
      await sleep(900);
    },
    crop: {
      phone: async (page) => { const t = await rectOf(page, [".gx-tools"]), c = await rectOf(page, [".gx-card.open"]); return { x: 0, y: t.y - 64, w: 390, h: c.y + c.h + 12 - (t.y - 64) }; },
    },
    pins: { desktop: [pin(1, ".gx-search"), pin(2, "#gx-year", "#gx-lang", "#gx-sort"), pin(3, ".gx-card:hover .gx-stats")],
            phone: [pin(1, ".gx-search"), pin(2, "#gx-year", "#gx-lang", "#gx-sort"), pin(3, ".gx-card.open .gx-stats")] },
  },
  {
    id: "clips", url: "/clips", height: { desktop: 960, phone: 1500 },
    async prepare(page) { await page.locator(".cl-card").first().waitFor(); await sleep(900); },
    crop: {
      phone: async (page) => { const s = await rectOf(page, [".cl-search"]), c = await rectOf(page, [".cl-card"]); return { x: 0, y: s.y - 64, w: 390, h: c.y + c.h + 14 - (s.y - 64) }; },
    },
    pins: { desktop: [pin(1, ".cl-search"), pin(2, ".cl-card"), pin(3, ".cl-reelsbtn")],
            phone: [pin(1, ".cl-search"), pin(2, ".cl-card"), pin(3, ".cl-reelsbtn")] },
  },
  {
    id: "saved", url: "/saved", height: { desktop: 860, phone: 1500 },
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
    crop: {
      phone: async (page) => { const f = await rectOf(page, [".sv-folders"]), i = await rectOf(page, [".sv-it"]); return { x: 0, y: f.y - 64, w: 390, h: i.y + i.h + 14 - (f.y - 64) }; },
    },
    pins: { desktop: [pin(1, ".sv-tabs"), pin(2, ".sv-folders"), pin(3, ".sv-note")],
            phone: [pin(1, ".sv-tabs"), pin(2, ".sv-folders"), pin(3, ".sv-note")] },
  },
  {
    id: "insights", url: "/insights", height: { desktop: 1400, phone: 1700 },
    async prepare(page) { await page.locator(".in-tiles").first().waitFor(); await sleep(1200); },
    crop: {
      desktop: async (page) => { const t = await rectOf(page, [".in-tiles"]), r = await rectOf(page, ["section[aria-labelledby='in-topics-h'] a:visible"]); return { x: 220, y: t.y - 90, w: 1000, h: r.y + r.h + 30 - (t.y - 90) }; },
      phone: async (page) => { const t = await rectOf(page, [".in-tiles"]), r = await rectOf(page, ["section[aria-labelledby='in-topics-h'] a:visible"]); return { x: 0, y: t.y - 90, w: 390, h: r.y + r.h + 24 - (t.y - 90) }; },
    },
    pins: { desktop: [pin(1, ".in-tiles"), pin(2, "#in-topics-h"), pin(3, "section[aria-labelledby='in-topics-h'] a:visible")],
            phone: [pin(1, ".in-tiles"), pin(2, "#in-topics-h"), pin(3, "section[aria-labelledby='in-topics-h'] a:visible")] },
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

const r4 = (v) => +v.toFixed(4);

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
      document.querySelectorAll(".sv-whose b").forEach((e) => { e.textContent = "Your"; }); // Saved says "tester's saved items"
      document.querySelectorAll(".prep-meta").forEach((e) => { e.textContent = (e.textContent || "").replace(/tester/i, "you"); }); // "prepared for tester"
      document.querySelectorAll(".toasts").forEach((e) => { e.style.display = "none"; }); // "Moved to ..." after a save
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(500);

    const crop = await (slide.crop?.[sizeName]?.(page) ?? { x: 0, y: 0, w: size.width, h: height });
    const c = { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.round(crop.w), h: Math.round(crop.h) };
    const pins = [];
    for (const p of slide.pins[sizeName]) {
      const r = await rectOf(page, p.selectors);
      const x = r.x - c.x, y = r.y - c.y;
      if (x < -1 || y < -1 || x + r.w > c.w + 1 || y + r.h > c.h + 1) {
        throw new Error(`pin ${p.n} (${p.selectors.join(" + ")}) is outside the picture: box ${Math.round(x)},${Math.round(y)} ${Math.round(r.w)}x${Math.round(r.h)} in ${c.w}x${c.h}`);
      }
      pins.push({ n: p.n, x: r4(Math.max(0, x) / c.w), y: r4(Math.max(0, y) / c.h), w: r4(Math.min(r.w, c.w - x) / c.w), h: r4(Math.min(r.h, c.h - y) / c.h) });
    }
    const png = await page.screenshot({ type: "png", clip: { x: c.x, y: c.y, width: c.w, height: c.h } });
    const file = `${slide.id}-${size.tag}.webp`;
    const info = await sharp(png).webp({ quality: 80, effort: 5 }).toFile(path.join(OUT, file));
    log(`${file}: ${info.width}x${info.height}, ${(info.size / 1024).toFixed(0)} KB, ratio ${(c.w / c.h).toFixed(2)}, ${pins.length} targets`);
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

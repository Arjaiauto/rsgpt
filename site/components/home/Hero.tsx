"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Logo } from "@/components/Logo";
import { LoginButton, LOGIN_EVENT } from "./LoginButton";
import { makePrint, startCloth, type ClothHandle } from "./cloth";

const DROP_MS = 800; // Log in button: cloth falls, then the login view
const TEAR_MS = 1000; // pulled off by hand

export function Hero() {
  const router = useRouter();
  const heroRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stillRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [hintDone, setHintDone] = useState(false);

  useEffect(() => {
    const hero = heroRef.current!, canvas = canvasRef.current!, still = stillRef.current!;
    const glow = glowRef.current!, title = titleRef.current!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const fine = matchMedia("(pointer: fine)").matches;
    const cursorFx = fine && !reduce;
    // A hidden-then-shown route keeps its DOM, so start clean every time.
    hero.classList.remove("leaving", "no-cloth");
    title.style.transform = "";

    let cloth: ClothHandle | null = null;
    let cancelled = false;
    const timers: number[] = [];
    let leaving = false;
    router.prefetch("/login");

    const goLogin = (delay: number) => {
      if (leaving) return;
      leaving = true;
      glow.classList.remove("on");
      if (delay && cloth) {
        cloth.drop();
        timers.push(window.setTimeout(() => router.push("/login"), delay));
      } else router.push("/login");
    };
    const onLogin = () => goLogin(scrollY < 40 && !reduce && cloth?.live() ? DROP_MS : 0);
    window.addEventListener(LOGIN_EVENT, onLogin);

    (async () => {
      const family = getComputedStyle(document.documentElement).getPropertyValue("--font-inter").trim() || "Inter";
      try {
        await document.fonts.load(`600 230px ${family}`);
        await document.fonts.load(`500 30px ${family}`);
      } catch {}
      if (cancelled) return;
      cloth = startCloth({ hero, canvas, still }, makePrint(family), {
        reduce,
        ripple: cursorFx,
        // Reduced motion: pulling it off still logs in, but without the long fall (spec: a short fade instead).
        onTear: () => goLogin(reduce ? 0 : TEAR_MS),
        onGrab: () => setHintDone(true),
      });
    })();

    /* cursor glow, title parallax and magnetic pills (mouse only, not under reduced motion) */
    const cleanups: (() => void)[] = [];
    if (cursorFx) {
      let gx = innerWidth / 2, gy = innerHeight / 2, tx = gx, ty = gy, glowRaf = 0;
      const glowLoop = () => {
        gx += (tx - gx) * 0.14; gy += (ty - gy) * 0.14;
        glow.style.transform = `translate3d(${gx}px,${gy}px,0)`;
        glowRaf = Math.abs(tx - gx) + Math.abs(ty - gy) > 0.3 ? requestAnimationFrame(glowLoop) : 0;
      };
      const onMove = (e: PointerEvent) => {
        if (e.pointerType !== "mouse" || leaving) return;
        tx = e.clientX; ty = e.clientY;
        glow.classList.add("on");
        if (!glowRaf) glowRaf = requestAnimationFrame(glowLoop);
        glow.classList.toggle("tight", !!(e.target as Element | null)?.closest?.(".pill"));
        const r = hero.getBoundingClientRect();
        if (e.clientY < r.bottom) {
          const px = (e.clientX / innerWidth - 0.5) * 2, py = (e.clientY / innerHeight - 0.5) * 2;
          title.style.transform = `translate(${px * -10}px,${py * -6}px)`;
          cloth?.pointerMoved(e);
        }
      };
      const onLeave = () => glow.classList.remove("on");
      addEventListener("pointermove", onMove, { passive: true });
      document.addEventListener("pointerleave", onLeave);
      cleanups.push(() => {
        removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerleave", onLeave);
        if (glowRaf) cancelAnimationFrame(glowRaf);
        glow.classList.remove("on");
      });
      document.querySelectorAll<HTMLElement>(".home .pill").forEach((p) => {
        const pm = (e: PointerEvent) => {
          const b = p.getBoundingClientRect();
          p.style.setProperty("--mx", ((e.clientX - b.left - b.width / 2) * 0.22).toFixed(1) + "px");
          p.style.setProperty("--my", ((e.clientY - b.top - b.height / 2) * 0.3).toFixed(1) + "px");
        };
        const pl = () => { p.style.setProperty("--mx", "0px"); p.style.setProperty("--my", "0px"); };
        p.addEventListener("pointermove", pm);
        p.addEventListener("pointerleave", pl);
        cleanups.push(() => { p.removeEventListener("pointermove", pm); p.removeEventListener("pointerleave", pl); pl(); });
      });
    }

    return () => {
      cancelled = true;
      window.removeEventListener(LOGIN_EVENT, onLogin);
      timers.forEach(clearTimeout);
      cleanups.forEach((f) => f());
      cloth?.destroy();
    };
  }, [router]);

  return (
    <>
      <div className="glow" ref={glowRef} aria-hidden="true" />
      <section className="screen" id="hero" ref={heroRef} aria-label="Cuepoint">
        <canvas
          className="hero__cloth"
          ref={canvasRef}
          role="img"
          tabIndex={-1}
          aria-label="A violet holographic cloth printed with the Cuepoint wordmark. Grab it and tug it around."
        />
        <canvas className="hero__still" ref={stillRef} width={1024} height={1024} aria-hidden="true" />
        <header className="nav rise">
          <Logo href="/" />
          <div className="nav__links">
            <a className="pill pill--ghost" href="#built">How it was built</a>
            <LoginButton className="pill pill--primary pill--sm" />
          </div>
        </header>
        <div className="copy">
          <h1 className="title" ref={titleRef}>
            <span className="rise">500 episodes.</span>
            <span className="soft rise d1">One search.</span>
          </h1>
          <div className="cta-row rise d2">
            <LoginButton className="pill pill--primary" />
            <span className={`tearhint${hintDone ? " done" : ""}`}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12" />
                <path d="M11 11.5v-2a1.5 1.5 0 0 1 3 0V12" />
                <path d="M14 10.5a1.5 1.5 0 0 1 3 0V12" />
                <path d="M17 11.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.6a6 6 0 0 1-4.6-2.2L4.6 15.4a1.5 1.5 0 0 1 2.2-2l1.2 1.1" />
              </svg>
              <span>or <b>pull the cloth off</b> to log in</span>
            </span>
          </div>
        </div>
        <a className="scrollhint rise d3" href="#built">
          How it was built<i aria-hidden="true" />
        </a>
      </section>
    </>
  );
}

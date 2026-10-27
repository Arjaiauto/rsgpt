// The hanging holographic cloth from design/01-home-and-login.html: a Verlet cloth pinned at two corners,
// drawn with WebGL over a generated print, with a soft shadow, cursor ripple and tear-off.
// Ported as-is from the mockup; only the wiring (start/stop, callbacks) is new.

export type ClothElements = {
  hero: HTMLElement;
  canvas: HTMLCanvasElement;
  still: HTMLCanvasElement;
};

export type ClothHandle = {
  /** Unpins the cloth so it falls off the screen. */
  drop: () => void;
  /** True while the WebGL cloth is live (false when showing the still image). */
  live: () => boolean;
  /** Pointer position in cloth units plus a "moved" flag for the cursor ripple. */
  pointerMoved: (e: { clientX: number; clientY: number }) => void;
  isHeld: () => boolean;
  destroy: () => void;
};

type Prog = { p: WebGLProgram; u: (n: string) => WebGLUniformLocation | null; a: (n: string) => number };

/* ---------- settings ---------- */
const S = {
  size: 0.9, aspect: 1.12, spread: 0.98, pinRoll: 5.5, flutter: 0.35, damping: 0.3, stiffness: 0.6, crumple: 0.55,
  grabRadius: 0.12, carryRadius: 0.2, gravity: 2.6, tilt: -10, turn: -12, perspective: 0.45, maxSpeed: 12, steps: 8,
};
const COLS = 46, ROWS = 42, N = COLS * ROWS;
const CH = S.size, CW = S.size * S.aspect;
const tl = (S.tilt * Math.PI) / 180, tr = (S.turn * Math.PI) / 180;
const R = [
  Math.cos(tr), 0, Math.sin(tr),
  Math.sin(tl) * Math.sin(tr), Math.cos(tl), -Math.sin(tl) * Math.cos(tr),
  -Math.cos(tl) * Math.sin(tr), Math.sin(tl), Math.cos(tl) * Math.cos(tr),
];
const CAM = Math.exp(Math.log(18) * (1 - S.perspective) + Math.log(1.7) * S.perspective);
const idx = (c: number, r: number) => r * COLS + c;

/* ---------- printed texture (generated) ---------- */
export function makePrint(family: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 1024;
  const g = c.getContext("2d")!;
  const ls = (v: string) => { if ("letterSpacing" in g) (g as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = v; };
  const lg = g.createLinearGradient(0, 0, 1024, 1024);
  lg.addColorStop(0, "#2a0a8f"); lg.addColorStop(0.5, "#5b07fb"); lg.addColorStop(1, "#12063f");
  g.fillStyle = lg; g.fillRect(0, 0, 1024, 1024);
  const glow = (x: number, y: number, rad: number, col: string) => {
    const rg = g.createRadialGradient(x, y, 0, x, y, rad);
    rg.addColorStop(0, col); rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg; g.fillRect(0, 0, 1024, 1024);
  };
  glow(820, 180, 540, "rgba(165,139,255,0.25)");
  glow(180, 880, 500, "rgba(79,227,193,0.12)");
  g.strokeStyle = "rgba(255,255,255,0.10)"; g.lineWidth = 2;
  for (let i = 0; i < 40; i++) {
    const base = 352 + i * 8.2;
    g.beginPath();
    for (let x = 0; x <= 1024; x += 6) {
      const env = Math.pow(Math.sin((Math.PI * x) / 1024), 1.4);
      const a = env * (18 * Math.sin(x * 0.021 + i * 0.35) + 11 * Math.sin(x * 0.057 - i * 0.8) + 6 * Math.sin(x * 0.11 + i));
      if (x) g.lineTo(x, base + a * (1 - Math.abs(i - 19.5) / 26)); else g.moveTo(x, base);
    }
    g.stroke();
  }
  g.fillStyle = "rgba(255,255,255,0.94)";
  g.textAlign = "left"; g.textBaseline = "alphabetic";
  const fs = 210;
  g.font = `600 ${fs}px ${family}, Helvetica, Arial, sans-serif`; ls("-10px");
  const w1 = g.measureText("cuepo").width, w2 = g.measureText("nt").width, ciW = 0.27 * fs;
  const x0 = 512 - (w1 + ciW + w2) / 2, base = 540;
  g.fillText("cuepo", x0, base); g.fillText("nt", x0 + w1 + ciW, base);
  const rr = (x: number, y: number, w: number, h: number, r: number) => {
    g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); g.fill();
  };
  const sx = x0 + w1 + 0.075 * fs, sw = 0.12 * fs, sh = 0.545 * fs;
  rr(sx, base - sh, sw, sh, sw / 2);
  const cxm = sx + sw / 2, ty = base - sh - 0.33 * fs, tw = 0.25 * fs, th = 0.21 * fs;
  g.fillStyle = "#4fe3c1"; g.beginPath(); g.moveTo(cxm - tw / 2, ty); g.lineTo(cxm + tw / 2, ty); g.lineTo(cxm, ty + th); g.closePath(); g.fill();
  g.textAlign = "center"; g.textBaseline = "middle";
  g.fillStyle = "rgba(255,255,255,0.70)";
  g.font = `500 30px ${family}, Helvetica, Arial, sans-serif`; ls("5.4px");
  g.fillText("500 EPISODES · ONE SEARCH", 512, 640);
  return c;
}

/* ---------- shaders ---------- */
const VS = `attribute vec3 aP;attribute vec3 aN;attribute vec2 aUv;uniform mat3 uR;uniform float uCAM,uZoom,uCx,uCy,uA;varying vec3 vN;varying vec3 vP;varying vec2 vUv;
void main(){vec3 q=uR*aP;float s=uCAM/max(uCAM-q.z,0.001);vec2 sc=q.xy*s*uZoom;gl_Position=vec4(2.0*(uCx+sc.x/uA)-1.0,1.0-2.0*(uCy-sc.y),-q.z*0.5,1.0);vN=uR*aN;vP=q;vUv=aUv;}`;
const FS_CLOTH = `precision highp float;varying vec3 vN;varying vec3 vP;varying vec2 vUv;uniform sampler2D uTex;uniform float uHasTex,uCAM;
float boxL(vec3 d,vec3 c,vec2 hs,float soft){vec3 up=abs(c.y)>0.9?vec3(1.0,0.0,0.0):vec3(0.0,1.0,0.0);vec3 a=normalize(cross(up,c));vec3 b=cross(c,a);float x=dot(d,a),y=dot(d,b);
return step(0.0,dot(d,c))*smoothstep(-0.5,0.5,(hs.x-abs(x))/soft)*smoothstep(-0.5,0.5,(hs.y-abs(y))/soft);}
vec3 rainbow(float p){return clamp(vec3(0.74,0.58,0.96)+vec3(0.26,0.24,0.10)*cos(6.2831853*(p+vec3(0.0,0.28,0.62))),0.0,1.0);}
void main(){vec3 n=normalize(vN);bool back=n.z<0.0;if(back)n=-n;vec3 V=normalize(vec3(0.0,0.0,uCAM)-vP);vec3 Rf=reflect(-V,n);vec3 KEY=normalize(vec3(-0.42,0.45,0.79));
float nv=clamp(dot(n,V),0.0,1.0);float nl=max(dot(n,KEY),0.0);
vec3 print=uHasTex>0.5?pow(texture2D(uTex,vUv).rgb,vec3(2.2)):vec3(0.10,0.02,0.32);
float shade=0.46+0.68*nl+0.08*n.y;float key=pow(max(dot(Rf,KEY),0.0),26.0);
float strip=boxL(Rf,normalize(vec3(0.08,0.93,0.36)),vec2(1.1,0.07),0.22);float side=boxL(Rf,normalize(vec3(0.86,0.12,0.50)),vec2(0.06,0.85),0.20);float fill=boxL(Rf,KEY,vec2(0.42,0.30),0.35);
float phase=3.0*(0.85*dot(n.xy,vec2(0.6,0.8))+0.75*(1.0-nv)+0.3*dot(Rf.xy,vec2(-0.8,0.6)))+0.4*sin(5.0*vUv.x+7.0*vUv.y);
vec3 holo=mix(vec3(1.0),pow(rainbow(phase),vec3(2.2)),0.8);float lum=dot(print,vec3(0.2126,0.7152,0.0722));float gloss=mix(1.0,0.45,smoothstep(0.55,0.9,lum));
vec3 spec=holo*gloss*mix(vec3(1.0),print*2.4+0.08,0.65)*(0.34*key+0.11*strip+0.07*side+0.02*fill);
vec3 col=print*shade+spec+holo*print*0.6*pow(1.0-nv,3.0);
if(back){vec3 foil=vec3(0.30,0.22,0.52)*(0.35+0.9*nl)+spec*1.3;col=mix(foil,print*shade,0.38);}
col=min(col,vec3(0.8))+0.2*(1.0-exp(-max(col-0.8,vec3(0.0))/0.2));gl_FragColor=vec4(pow(col,vec3(1.0/2.2)),1.0);}`;
const FS_SOLID = `precision mediump float;void main(){gl_FragColor=vec4(1.0);}`;
const VS_TRI = `attribute vec2 aXY;varying vec2 vUv;void main(){vUv=aXY*0.5+0.5;gl_Position=vec4(aXY,0.0,1.0);}`;
const FS_SHADOW = `precision mediump float;varying vec2 vUv;uniform sampler2D uT;uniform vec2 uTexel,uShift;uniform float uSpacing,uStrength;uniform vec3 uColor;
void main(){float a=0.0,ws=0.0;for(int i=-3;i<=3;i++){for(int j=-3;j<=3;j++){float w=exp(-float(i*i+j*j)/6.0);a+=w*texture2D(uT,vUv-uShift+vec2(float(i),float(j))*uTexel*uSpacing).a;ws+=w;}}
a=a/ws*uStrength;gl_FragColor=vec4(uColor*a,a);}`;

export function startCloth(
  els: ClothElements,
  print: HTMLCanvasElement,
  opts: { reduce: boolean; ripple: boolean; onTear: () => void; onGrab: () => void },
): ClothHandle {
  const { hero, canvas, still } = els;
  const { reduce } = opts;

  /* ---------- physics state ---------- */
  const P = new Float32Array(N * 3), Q = new Float32Array(N * 3), NR = new Float32Array(N * 3);
  const U = new Float32Array(N), V = new Float32Array(N), FX = new Float32Array(N), FY = new Float32Array(N);
  const inv = new Float32Array(N), fixed = new Uint8Array(N), W = new Float32Array(N);
  const EX = new Float32Array(N), EY = new Float32Array(N), EZ = new Float32Array(N);
  const dL = new Float32Array(N), dR = new Float32Array(N);
  const iL = idx(0, ROWS - 1), iR = idx(COLS - 1, ROWS - 1);
  const pinL = [0, 0, 0], pinR = [0, 0, 0];
  let la = new Int32Array(0), lb = new Int32Array(0), lr = new Float32Array(0), lk = new Float32Array(0), nLinks = 0;
  let T = 0, dampCur = S.damping, grav = S.gravity, pinsOn = true, sweepFwd = true;
  let held: { i: number; depth: number; ox: number; oy: number } | null = null;
  let ptr: [number, number] = [0, 0], leaving = false;

  const ridge = (x: number) => Math.sqrt(Math.sin(x) ** 2 + 0.03) - 0.64;
  const crease = (u: number, v: number) =>
    S.crumple * 0.045 * CH *
    (ridge(2.7 * u + 2.9 * v + 0.7) + 0.8 * ridge(-2.6 * u + 3.3 * v + 2.1) + 0.5 * Math.sin(4.9 * u - 1.4 * v + 2.2) +
      0.55 * ridge(1.1 * u + 6.4 * v + 1.3) + 0.4 * ridge(8.3 * u + 3.9 * v + 0.2) + 0.3 * ridge(-5.7 * u + 9.1 * v + 1.6));

  function tether(x: number, y: number, z: number, i: number): [number, number, number] {
    if (!pinsOn) return [x, y, z];
    for (const [p, lim] of [[pinL, dL[i]], [pinR, dR[i]]] as [number[], number][]) {
      const dx = x - p[0], dy = y - p[1], dz = z - p[2], d = Math.hypot(dx, dy, dz);
      if (d > lim) { const s = lim / d; x = p[0] + dx * s; y = p[1] + dy * s; z = p[2] + dz * s; }
    }
    return [x, y, z];
  }

  function initCloth() {
    const rest = new Float32Array(N * 3);
    const roll = (S.pinRoll * Math.PI) / 180, half = 0.5 * CW * S.spread, top = 0.5 * CH;
    pinL[0] = -half * Math.cos(roll); pinL[1] = top + half * Math.sin(roll); pinL[2] = 0;
    pinR[0] = half * Math.cos(roll); pinR[1] = top - half * Math.sin(roll); pinR[2] = 0;
    const a = -roll, ca = Math.cos(a), sa = Math.sin(a);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const i = idx(c, r), u = c / (COLS - 1), v = r / (ROWS - 1);
      U[i] = u; V[i] = v;
      const fx = (u - 0.5) * CW, fy = (v - 0.5) * CH, z = crease(u, v);
      FX[i] = fx; FY[i] = fy;
      rest[i * 3] = fx; rest[i * 3 + 1] = fy; rest[i * 3 + 2] = z;
      const sx = fx * (S.spread + (1 - S.spread) * (1 - v) ** 2), dy = fy - top;
      const x = sx * ca - dy * sa, y = top + sx * sa + dy * ca;
      P[i * 3] = Q[i * 3] = x; P[i * 3 + 1] = Q[i * 3 + 1] = y; P[i * 3 + 2] = Q[i * 3 + 2] = z;
      inv[i] = 1;
      dL[i] = 1.02 * Math.hypot(fx + 0.5 * CW, fy - 0.5 * CH);
      dR[i] = 1.02 * Math.hypot(fx - 0.5 * CW, fy - 0.5 * CH);
    }
    for (const [i, p] of [[iL, pinL], [iR, pinR]] as [number, number[]][]) {
      inv[i] = 0;
      for (let k = 0; k < 3; k++) P[i * 3 + k] = Q[i * 3 + k] = p[k];
    }
    const L: number[] = [];
    const bend = 0.02 + (0.6 - 0.02) * S.stiffness;
    const add = (c1: number, r1: number, c2: number, r2: number, k: number) => {
      if (c2 < 0 || c2 >= COLS || r2 < 0 || r2 >= ROWS) return;
      const i = idx(c1, r1), j = idx(c2, r2);
      L.push(i, j, Math.hypot(rest[j * 3] - rest[i * 3], rest[j * 3 + 1] - rest[i * 3 + 1], rest[j * 3 + 2] - rest[i * 3 + 2]), k);
    };
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      add(c, r, c + 1, r, 1); add(c, r, c, r + 1, 1);
      add(c, r, c + 1, r + 1, 0.5); add(c + 1, r, c, r + 1, 0.5);
      add(c, r, c + 2, r, bend); add(c, r, c, r + 2, bend);
      add(c, r, c + 5, r, bend * 0.5); add(c, r, c, r + 5, bend * 0.5);
    }
    nLinks = L.length / 4;
    la = new Int32Array(nLinks); lb = new Int32Array(nLinks); lr = new Float32Array(nLinks); lk = new Float32Array(nLinks);
    for (let n = 0; n < nLinks; n++) { la[n] = L[n * 4]; lb[n] = L[n * 4 + 1]; lr[n] = L[n * 4 + 2]; lk[n] = L[n * 4 + 3]; }
    T = 0; grav = S.gravity; pinsOn = true; held = null;
    dampCur = 1;
    for (let s = 0; s < 360; s++) step(1 / 240);
    dampCur = S.damping;
  }

  /* ---------- view ---------- */
  let A = 1.6, cx = 0.33, cy = 0.485, zoom = 1, heroH = 724;
  function computeView() {
    const w = hero.clientWidth, h = hero.clientHeight;
    if (!w || !h) return;
    A = w / h; heroH = h;
    if (w >= 1100 && A >= 1.25) { cx = 0.33; cy = 0.485; zoom = Math.min(1, (0.52 * A) / (CW * 1.12)); }
    else { cx = 0.5; cy = A < 0.75 ? 0.29 : 0.31; zoom = Math.min(1, (0.92 * A) / (CW * 1.12), (A < 0.75 ? 0.5 : 0.56) / CH); }
    const dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    if (gl) resizeShadow();
  }
  function project(i: number): [number, number, number, number, number] {
    const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
    const qx = R[0] * x + R[1] * y + R[2] * z, qy = R[3] * x + R[4] * y + R[5] * z, qz = R[6] * x + R[7] * y + R[8] * z;
    const s = CAM / Math.max(CAM - qz, 0.001);
    return [qx * s, qy * s, qz, qx, qy];
  }

  /* ---------- grabbing ---------- */
  function pointerUnits(e: { clientX: number; clientY: number }): [number, number] {
    const b = canvas.getBoundingClientRect();
    return [(((e.clientX - b.left) / b.width - cx) * A) / zoom, (cy - (e.clientY - b.top) / b.height) / zoom];
  }
  function pick(p: [number, number]) {
    let best = -1, bestScore = Infinity;
    const lim = S.grabRadius / zoom;
    for (let i = 0; i < N; i++) {
      const s = project(i), d = Math.hypot(s[0] - p[0], s[1] - p[1]);
      if (d < lim) { const sc = d - 0.08 * s[2]; if (sc < bestScore) { bestScore = sc; best = i; } }
    }
    return best;
  }
  function grab(i: number, p: [number, number]) {
    const s = project(i), depth = s[2], k = (CAM - depth) / CAM;
    held = { i, depth, ox: s[3] - p[0] * k, oy: s[4] - p[1] * k };
    const gx = FX[i], gy = FY[i];
    for (let j = 0; j < N; j++) {
      const d = Math.hypot(FX[j] - gx, FY[j] - gy) / (S.carryRadius * CH);
      W[j] = d < 1 ? (1 - d * d) ** 2 : 0;
    }
    W[i] = 1;
    if (pinsOn) { W[iL] = 0; W[iR] = 0; }
  }
  function applyHold() {
    if (!held) return;
    const k = (CAM - held.depth) / CAM, qx = ptr[0] * k + held.ox, qy = ptr[1] * k + held.oy, qz = held.depth;
    let x = R[0] * qx + R[3] * qy + R[6] * qz, y = R[1] * qx + R[4] * qy + R[7] * qz, z = R[2] * qx + R[5] * qy + R[8] * qz;
    if (pinsOn) {
      const sL = Math.hypot(x - pinL[0], y - pinL[1], z - pinL[2]) - dL[held.i];
      const sR = Math.hypot(x - pinR[0], y - pinR[1], z - pinR[2]) - dR[held.i];
      if (Math.max(sL, sR) > 0.3 * CH) { if (!leaving) opts.onTear(); return; }
    }
    [x, y, z] = tether(x, y, z, held.i);
    const i = held.i, dx = x - P[i * 3], dy = y - P[i * 3 + 1], dz = z - P[i * 3 + 2];
    for (let j = 0; j < N; j++) {
      const w = W[j];
      if (!w) continue;
      const m = w >= 0.98 ? 1 : w;
      if (w >= 0.98) fixed[j] = 1;
      P[j * 3] += dx * m; P[j * 3 + 1] += dy * m; P[j * 3 + 2] += dz * m;
      Q[j * 3] += dx * m; Q[j * 3 + 1] += dy * m; Q[j * 3 + 2] += dz * m;
    }
  }

  /* ---------- simulation step ---------- */
  function step(h: number) {
    T += h;
    const damp = Math.exp(-(0.15 + 5.85 * dampCur) * h);
    const gust = 0.6 + 0.4 * Math.sin(0.37 * T) * Math.sin(0.23 * T + 1);
    const wind = reduce ? 0 : S.flutter * 2.4 * gust * (grav / 2.6);
    fixed.fill(0);
    if (held) applyHold();
    const cap = S.maxSpeed * h, h2 = h * h;
    for (let i = 0; i < N; i++) {
      if (inv[i] === 0 || fixed[i]) continue;
      const u = U[i], v = V[i];
      const s1 = Math.sin(9.1 * u - 3.7 * v + 3.1 * T), s2 = Math.sin(6.3 * u + 7.9 * v - 2.3 * T + 1.3);
      const s3 = Math.sin(2.9 * u + 1.7 * T + 0.8 * Math.sin(0.5 * T)) * Math.cos(2.3 * v - 0.9 * T);
      const ax = wind * 0.25 * Math.sin(3.3 * v + 1.1 * T + u) + EX[i], ay = wind * 0.1 * s2 - grav + EY[i];
      const az = wind * (0.45 * s1 + 0.35 * s2 + 0.3 * s3) + EZ[i];
      const o = i * 3;
      let vx = (P[o] - Q[o]) * damp + ax * h2, vy = (P[o + 1] - Q[o + 1]) * damp + ay * h2, vz = (P[o + 2] - Q[o + 2]) * damp + az * h2;
      const sp = Math.hypot(vx, vy, vz);
      if (sp > cap) { const s = cap / sp; vx *= s; vy *= s; vz *= s; }
      Q[o] = P[o]; Q[o + 1] = P[o + 1]; Q[o + 2] = P[o + 2];
      P[o] += vx; P[o + 1] += vy; P[o + 2] += vz;
    }
    const relax = (n: number) => {
      const a = la[n], b = lb[n];
      const wa = fixed[a] ? 0 : inv[a], wb = fixed[b] ? 0 : inv[b], ws = wa + wb;
      if (!ws) return;
      const oa = a * 3, ob = b * 3, dx = P[ob] - P[oa], dy = P[ob + 1] - P[oa + 1], dz = P[ob + 2] - P[oa + 2];
      const len = Math.hypot(dx, dy, dz);
      if (len < 1e-9) return;
      const c = (lk[n] * (len - lr[n])) / len / ws;
      P[oa] += dx * c * wa; P[oa + 1] += dy * c * wa; P[oa + 2] += dz * c * wa;
      P[ob] -= dx * c * wb; P[ob + 1] -= dy * c * wb; P[ob + 2] -= dz * c * wb;
    };
    if (sweepFwd) for (let n = 0; n < nLinks; n++) relax(n);
    else for (let n = nLinks - 1; n >= 0; n--) relax(n);
    sweepFwd = !sweepFwd;
    if (pinsOn) for (let i = 0; i < N; i++) {
      if (inv[i] === 0 || fixed[i]) continue;
      const o = i * 3, t = tether(P[o], P[o + 1], P[o + 2], i);
      P[o] = t[0]; P[o + 1] = t[1]; P[o + 2] = t[2];
    }
  }

  function normals() {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
      const i = idx(c, r), a = idx(Math.max(c - 1, 0), r) * 3, b = idx(Math.min(c + 1, COLS - 1), r) * 3;
      const d = idx(c, Math.max(r - 1, 0)) * 3, e = idx(c, Math.min(r + 1, ROWS - 1)) * 3;
      const hx = P[b] - P[a], hy = P[b + 1] - P[a + 1], hz = P[b + 2] - P[a + 2];
      const vx = P[e] - P[d], vy = P[e + 1] - P[d + 1], vz = P[e + 2] - P[d + 2];
      const nx = hy * vz - hz * vy, ny = hz * vx - hx * vz, nz = hx * vy - hy * vx, l = Math.hypot(nx, ny, nz) || 1;
      NR[i * 3] = nx / l; NR[i * 3 + 1] = ny / l; NR[i * 3 + 2] = nz / l;
    }
  }

  /* ---------- WebGL ---------- */
  let gl: WebGLRenderingContext | null = null;
  let progCloth: Prog, progSolid: Prog, progShadow: Prog;
  let bufP: WebGLBuffer, bufN: WebGLBuffer, bufUV: WebGLBuffer, bufIdx: WebGLBuffer, bufTri: WebGLBuffer;
  let nIdx = 0, tex: WebGLTexture, hasTex = 0, fbo: WebGLFramebuffer, fboTex: WebGLTexture, fboW = 1, fboH = 1;

  function compile(vs: string, fs: string): Prog {
    const g = gl!;
    const mk = (t: number, s: string) => {
      const sh = g.createShader(t)!;
      g.shaderSource(sh, s); g.compileShader(sh);
      if (!g.getShaderParameter(sh, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(sh) || "shader");
      return sh;
    };
    const p = g.createProgram()!;
    g.attachShader(p, mk(g.VERTEX_SHADER, vs)); g.attachShader(p, mk(g.FRAGMENT_SHADER, fs)); g.linkProgram(p);
    if (!g.getProgramParameter(p, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(p) || "link");
    return { p, u: (n) => g.getUniformLocation(p, n), a: (n) => g.getAttribLocation(p, n) };
  }
  function noCloth() { hero.classList.add("no-cloth"); running = false; }
  function resizeShadow() {
    const g = gl!;
    fboW = Math.max(1, Math.ceil(canvas.width / 8)); fboH = Math.max(1, Math.ceil(canvas.height / 8));
    g.bindTexture(g.TEXTURE_2D, fboTex);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, fboW, fboH, 0, g.RGBA, g.UNSIGNED_BYTE, null);
  }
  const onContextLost = (e: Event) => { e.preventDefault(); noCloth(); };
  function setupGL(): boolean {
    gl = canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: "high-performance" });
    if (!gl) return false;
    const g = gl;
    progCloth = compile(VS, FS_CLOTH); progSolid = compile(VS, FS_SOLID); progShadow = compile(VS_TRI, FS_SHADOW);
    bufP = g.createBuffer()!; bufN = g.createBuffer()!; bufUV = g.createBuffer()!; bufIdx = g.createBuffer()!; bufTri = g.createBuffer()!;
    const uv = new Float32Array(N * 2);
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const i = idx(c, r); uv[i * 2] = c / (COLS - 1); uv[i * 2 + 1] = 1 - r / (ROWS - 1); }
    g.bindBuffer(g.ARRAY_BUFFER, bufUV); g.bufferData(g.ARRAY_BUFFER, uv, g.STATIC_DRAW);
    const ix: number[] = [];
    for (let r = 0; r < ROWS - 1; r++) for (let c = 0; c < COLS - 1; c++) {
      const a = idx(c, r), b = idx(c + 1, r), d = idx(c, r + 1), e = idx(c + 1, r + 1);
      ix.push(a, b, e, a, e, d);
    }
    nIdx = ix.length;
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, bufIdx); g.bufferData(g.ELEMENT_ARRAY_BUFFER, new Uint16Array(ix), g.STATIC_DRAW);
    g.bindBuffer(g.ARRAY_BUFFER, bufP); g.bufferData(g.ARRAY_BUFFER, P.byteLength, g.DYNAMIC_DRAW);
    g.bindBuffer(g.ARRAY_BUFFER, bufN); g.bufferData(g.ARRAY_BUFFER, NR.byteLength, g.DYNAMIC_DRAW);
    g.bindBuffer(g.ARRAY_BUFFER, bufTri); g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW);
    tex = g.createTexture()!; g.bindTexture(g.TEXTURE_2D, tex);
    g.pixelStorei(g.UNPACK_FLIP_Y_WEBGL, false);
    g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, print);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR_MIPMAP_LINEAR);
    g.generateMipmap(g.TEXTURE_2D);
    const an = g.getExtension("EXT_texture_filter_anisotropic") || g.getExtension("WEBKIT_EXT_texture_filter_anisotropic");
    if (an) g.texParameterf(g.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, g.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    hasTex = 1;
    fboTex = g.createTexture()!; g.bindTexture(g.TEXTURE_2D, fboTex);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
    g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE); g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
    fbo = g.createFramebuffer()!; resizeShadow();
    g.bindFramebuffer(g.FRAMEBUFFER, fbo); g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, fboTex, 0);
    g.bindFramebuffer(g.FRAMEBUFFER, null);
    canvas.addEventListener("webglcontextlost", onContextLost);
    return true;
  }
  const Rcols = new Float32Array([R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]]);
  function bindMesh(pr: Prog) {
    const g = gl!;
    g.useProgram(pr.p);
    const aP = pr.a("aP"), aN = pr.a("aN"), aUv = pr.a("aUv");
    g.bindBuffer(g.ARRAY_BUFFER, bufP); g.enableVertexAttribArray(aP); g.vertexAttribPointer(aP, 3, g.FLOAT, false, 0, 0);
    if (aN >= 0) { g.bindBuffer(g.ARRAY_BUFFER, bufN); g.enableVertexAttribArray(aN); g.vertexAttribPointer(aN, 3, g.FLOAT, false, 0, 0); }
    if (aUv >= 0) { g.bindBuffer(g.ARRAY_BUFFER, bufUV); g.enableVertexAttribArray(aUv); g.vertexAttribPointer(aUv, 2, g.FLOAT, false, 0, 0); }
    g.uniformMatrix3fv(pr.u("uR"), false, Rcols); g.uniform1f(pr.u("uCAM"), CAM); g.uniform1f(pr.u("uZoom"), zoom);
    g.uniform1f(pr.u("uCx"), cx); g.uniform1f(pr.u("uCy"), cy); g.uniform1f(pr.u("uA"), A);
    g.bindBuffer(g.ELEMENT_ARRAY_BUFFER, bufIdx);
  }
  function unbindMesh(pr: Prog) { for (const n of ["aP", "aN", "aUv"]) { const l = pr.a(n); if (l >= 0) gl!.disableVertexAttribArray(l); } }
  function shadowPass(spacingMul: number, color: number[], strength: number) {
    const g = gl!;
    g.useProgram(progShadow.p);
    const a = progShadow.a("aXY");
    g.bindBuffer(g.ARRAY_BUFFER, bufTri); g.enableVertexAttribArray(a); g.vertexAttribPointer(a, 2, g.FLOAT, false, 0, 0);
    g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, fboTex); g.uniform1i(progShadow.u("uT"), 0);
    g.uniform2f(progShadow.u("uTexel"), 1 / fboW, 1 / fboH);
    g.uniform1f(progShadow.u("uSpacing"), (0.9 + (1.5 * zoom * heroH) / 724) * spacingMul);
    g.uniform2f(progShadow.u("uShift"), (-0.012 * zoom) / A, -0.045 * zoom);
    g.uniform3f(progShadow.u("uColor"), color[0], color[1], color[2]); g.uniform1f(progShadow.u("uStrength"), strength);
    g.drawArrays(g.TRIANGLES, 0, 3); g.disableVertexAttribArray(a);
  }
  function render() {
    const g = gl!;
    normals();
    g.bindBuffer(g.ARRAY_BUFFER, bufP); g.bufferSubData(g.ARRAY_BUFFER, 0, P);
    g.bindBuffer(g.ARRAY_BUFFER, bufN); g.bufferSubData(g.ARRAY_BUFFER, 0, NR);
    g.bindFramebuffer(g.FRAMEBUFFER, fbo); g.viewport(0, 0, fboW, fboH);
    g.disable(g.DEPTH_TEST); g.disable(g.BLEND); g.clearColor(0, 0, 0, 0); g.clear(g.COLOR_BUFFER_BIT);
    bindMesh(progSolid); g.drawElements(g.TRIANGLES, nIdx, g.UNSIGNED_SHORT, 0); unbindMesh(progSolid);
    g.bindFramebuffer(g.FRAMEBUFFER, null); g.viewport(0, 0, canvas.width, canvas.height);
    g.clearColor(0, 0, 0, 0); g.clearDepth(1); g.clear(g.COLOR_BUFFER_BIT | g.DEPTH_BUFFER_BIT);
    g.enable(g.BLEND); g.blendFunc(g.ONE, g.ONE_MINUS_SRC_ALPHA);
    shadowPass(3, [0.22, 0.05, 0.6], 0.18);
    shadowPass(1, [0, 0, 0.02], 0.55);
    g.disable(g.BLEND); g.enable(g.DEPTH_TEST); g.depthFunc(g.LEQUAL); g.disable(g.CULL_FACE);
    bindMesh(progCloth);
    g.activeTexture(g.TEXTURE0); g.bindTexture(g.TEXTURE_2D, tex); g.uniform1i(progCloth.u("uTex"), 0); g.uniform1f(progCloth.u("uHasTex"), hasTex);
    g.drawElements(g.TRIANGLES, nIdx, g.UNSIGNED_SHORT, 0); unbindMesh(progCloth);
  }

  /* ---------- cursor ripple ---------- */
  let mU: [number, number] = [0, 0], lastMove = 0, lastU: [number, number] | null = null, lastT = 0;
  const mV: [number, number] = [0, 0];
  function ripple() {
    const active = !held && !leaving && performance.now() - lastMove < 140;
    if (!active) { for (let i = 0; i < N; i++) { EX[i] *= 0.8; EY[i] *= 0.8; EZ[i] *= 0.8; } return; }
    let vx = mV[0], vy = mV[1];
    const sp = Math.hypot(vx, vy);
    if (sp > 3) { vx *= 3 / sp; vy *= 3 / sp; }
    const rad = 0.26;
    for (let i = 0; i < N; i++) {
      const s = project(i), d = Math.hypot(s[0] - mU[0], s[1] - mU[1]);
      if (d < rad) { const f = (1 - d / rad) ** 2; EX[i] = vx * 2.4 * f; EY[i] = vy * 2.4 * f; EZ[i] = -Math.min(sp, 3) * 1.8 * f; }
      else { EX[i] *= 0.8; EY[i] *= 0.8; EZ[i] *= 0.8; }
    }
  }

  /* ---------- loop ---------- */
  let running = false, onScreen = true, last = 0, raf = 0, destroyed = false;
  function frame(now: number) {
    raf = 0;
    if (!running || !onScreen || document.hidden || destroyed) return;
    const dt = Math.min(last ? (now - last) / 1000 : 1 / 60, 1 / 30);
    last = now;
    if (opts.ripple) ripple();
    const h = dt / S.steps;
    for (let s = 0; s < S.steps; s++) step(h);
    render();
    raf = requestAnimationFrame(frame);
  }
  function kick() { if (running && onScreen && !document.hidden && !raf && !destroyed) { last = 0; raf = requestAnimationFrame(frame); } }

  /* ---------- events ---------- */
  const onDown = (e: PointerEvent) => {
    if (leaving || (e.pointerType === "mouse" && e.button !== 0)) return;
    ptr = pointerUnits(e);
    const i = pick(ptr);
    if (i < 0) return;
    grab(i, ptr); canvas.setPointerCapture(e.pointerId); canvas.classList.add("is-held");
    opts.onGrab();
  };
  const onMove = (e: PointerEvent) => {
    ptr = pointerUnits(e);
    if (!held && e.pointerType === "mouse" && !leaving) canvas.classList.toggle("is-over", pick(ptr) >= 0);
  };
  const release = () => { held = null; canvas.classList.remove("is-held"); };
  const onTouchStart = (e: TouchEvent) => { if (leaving) return; const t = e.touches[0]; if (t && pick(pointerUnits(t)) >= 0) e.preventDefault(); };
  const onTouchMove = (e: TouchEvent) => { if (held) e.preventDefault(); };
  const io = new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; kick(); });
  const ro = new ResizeObserver(() => { computeView(); if (gl && running) render(); });
  const onResize = () => computeView();

  /* ---------- boot ---------- */
  still.getContext("2d")!.drawImage(print, 0, 0);
  initCloth(); computeView();
  // Reduced motion keeps the live cloth with no wind (see step()); it only moves when grabbed.
  // The still printed image is the fallback for when WebGL is not available.
  let ok = false;
  try { ok = setupGL(); } catch { ok = false; }
  if (!ok) noCloth();
  else {
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", release);
    canvas.addEventListener("pointercancel", release);
    canvas.addEventListener("lostpointercapture", release);
    canvas.addEventListener("touchstart", onTouchStart, { passive: false });
    canvas.addEventListener("touchmove", onTouchMove, { passive: false });
    io.observe(hero); ro.observe(hero);
    document.addEventListener("visibilitychange", kick);
    addEventListener("resize", onResize);
    computeView(); running = true; render(); kick();
  }

  return {
    drop() {
      leaving = true; held = null;
      canvas.classList.remove("is-over", "is-held"); hero.classList.add("leaving");
      pinsOn = false; inv[iL] = 1; inv[iR] = 1; grav = S.gravity * 1.6;
      EX.fill(0); EY.fill(0); EZ.fill(0);
    },
    live: () => running && !!gl,
    isHeld: () => !!held,
    pointerMoved(e) {
      const u = pointerUnits(e), now = performance.now();
      if (lastU && now > lastT) {
        const k = 1000 / (now - lastT);
        mV[0] = mV[0] * 0.5 + (u[0] - lastU[0]) * k * 0.5; mV[1] = mV[1] * 0.5 + (u[1] - lastU[1]) * k * 0.5;
      }
      lastU = u; lastT = now; mU = u; lastMove = now; kick();
    },
    destroy() {
      destroyed = true; running = false;
      if (raf) cancelAnimationFrame(raf);
      io.disconnect(); ro.disconnect();
      document.removeEventListener("visibilitychange", kick);
      removeEventListener("resize", onResize);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", release);
      canvas.removeEventListener("pointercancel", release);
      canvas.removeEventListener("lostpointercapture", release);
      canvas.removeEventListener("touchstart", onTouchStart);
      canvas.removeEventListener("touchmove", onTouchMove);
      canvas.removeEventListener("webglcontextlost", onContextLost);
    },
  };
}

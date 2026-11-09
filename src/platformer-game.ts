// Tiny "Special Delivery" platform game for an email verification page.
//
// newRunner, tick and mountGame are each self-contained, because they are
// serialized with Function.toString. They must not reference anything else at
// module scope. mountGame may call newRunner and tick, which will be in scope.

export function newRunner() {
  return { x: 24, y: 0, vy: 0, jumping: false, cleared: 0, won: false };
}

export function tick(s: ReturnType<typeof newRunner>, keys: number, blocks: readonly number[]): void {
  const SPEED = 4, JUMP_SPEED = 9, GRAVITY = 1;
  const HALF = 7, BLOCK_HALF = 12, BLOCK_TOP = 22, REACH = HALF + BLOCK_HALF;
  const MIN_X = HALF, MAX_X = 560 - HALF, MAILBOX_X = 516;
  if (s.won) return;

  const parcels = blocks;
  const over = (x: number, c: number) => Math.abs(x - c) < REACH;
  const supported = (x: number, y: number) => {
    if (y === 0) return true;
    if (y !== BLOCK_TOP) return false;
    for (let i = 0; i < parcels.length; i++) if (over(x, parcels[i])) return true;
    return false;
  };

  const left = (keys & 1) !== 0, right = (keys & 2) !== 0, jump = (keys & 4) !== 0;

  // A jump needs a fresh press while standing on the floor or on a parcel top.
  if (jump && !s.jumping && s.vy === 0 && supported(s.x, s.y)) s.vy = JUMP_SPEED;
  s.jumping = jump;

  // Horizontal movement. Below its top edge, a parcel is a solid wall.
  const fromX = s.x;
  const dx = (right ? SPEED : 0) - (left ? SPEED : 0);
  let x = Math.max(MIN_X, Math.min(MAX_X, fromX + dx));
  if (s.y < BLOCK_TOP) {
    for (let i = 0; i < parcels.length; i++) {
      const c = parcels[i];
      if (dx > 0 && fromX <= c - REACH && x > c - REACH) x = c - REACH;
      if (dx < 0 && fromX >= c + REACH && x < c + REACH) x = c + REACH;
    }
  }
  s.x = x;

  // Vertical movement: gravity, landing on parcel tops, and the floor.
  const fromY = s.y;
  if (s.vy !== 0 || !supported(s.x, s.y)) {
    let y = fromY + s.vy;
    s.vy -= GRAVITY;
    if (y < fromY) {
      for (let i = 0; i < parcels.length; i++) {
        if (fromY >= BLOCK_TOP && y <= BLOCK_TOP && over(s.x, parcels[i])) {
          y = BLOCK_TOP;
          s.vy = 0;
        }
      }
      if (y <= 0) {
        y = 0;
        s.vy = 0;
      }
    }
    s.y = y;
  }

  // A parcel counts as cleared, in order, when the courier's trailing edge
  // passes the parcel's far edge while above the floor.
  if (s.cleared < parcels.length) {
    const far = parcels[s.cleared] + BLOCK_HALF;
    if (fromY > 0 && fromX - HALF < far && s.x - HALF >= far) s.cleared += 1;
  }

  if (s.cleared >= parcels.length && s.x >= MAILBOX_X) s.won = true;
}

export function mountGame(blocks: number[], onWin: (moves: number[][]) => void): () => void {
  const W = 560, H = 210, GROUND = 176;
  const STEP_MS = 1000 / 30, MAX_TICKS = 2700, MAX_RUNS = 220;
  const LEFT = 1, RIGHT = 2, JUMP = 4;
  const PARCEL_HALF = 12, PARCEL_TOP = 22, REACH = 19, MAILBOX_X = 516;
  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const KEYS: Record<string, number> = {
    ArrowLeft: LEFT, KeyA: LEFT, a: LEFT, A: LEFT,
    ArrowRight: RIGHT, KeyD: RIGHT, d: RIGHT, D: RIGHT,
    ArrowUp: JUMP, Space: JUMP, ' ': JUMP,
  };
  const TWINKLES = [46, 22, 124, 48, 198, 16, 270, 40, 352, 22, 468, 52, 534, 18];

  const found = document.getElementById('game');
  if (!(found instanceof HTMLCanvasElement)) throw new Error('Open this game in a browser that supports canvas.');
  const canvas: HTMLCanvasElement = found;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Open this game in a browser that supports canvas.');
  const ctx: CanvasRenderingContext2D = context;

  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;
  if (canvas.tabIndex < 0) canvas.tabIndex = 0;
  if (!canvas.hasAttribute('aria-label')) {
    canvas.setAttribute('aria-label', 'Delivery game: hop over both parcels and reach the mailbox. Arrow keys or A and D move, Up or Space jumps.');
  }

  const controls: Array<[HTMLElement, number]> = [];
  const ids: Array<[string, number]> = [['left', LEFT], ['right', RIGHT], ['jump', JUMP]];
  for (let i = 0; i < ids.length; i++) {
    const el = document.getElementById(ids[i][0]);
    if (el) controls.push([el, ids[i][1]]);
  }

  const parcels = blocks;

  // ---- State ---------------------------------------------------------------
  let runner = newRunner();
  let prevX = runner.x, prevY = runner.y;
  let runs: number[][] = [];
  let ticks = 0, latched = 0;
  let phase: 'ready' | 'playing' | 'over' | 'won' = 'ready';
  let overText = '';
  let disposed = false;
  let raf = 0, lastTime = 0, lastDraw = 0, acc = 0;
  let squash = 0, walk = 0, facing = 1, flag = 0;
  const heldKeys: Record<string, number> = {};
  const heldPointers = new Map<number, number>();
  const offs: Array<() => void> = [];
  const background = paintBackground();

  function on<E extends Event>(target: EventTarget, type: string, fn: (e: E) => void) {
    const handler = fn as unknown as EventListener;
    target.addEventListener(type, handler);
    offs.push(() => target.removeEventListener(type, handler));
  }

  function heldMask() {
    let m = 0;
    for (const k in heldKeys) m |= heldKeys[k];
    heldPointers.forEach((bit) => { m |= bit; });
    return m;
  }

  function releaseAll() {
    for (const k in heldKeys) delete heldKeys[k];
    heldPointers.clear();
    latched = 0;
  }

  function wake() {
    if (!raf && !disposed) raf = requestAnimationFrame(frame);
  }

  // Called when a control is pressed. Returns true if the press should count as held.
  function press(bit: number): boolean {
    if (disposed) return false;
    if (phase === 'over') {
      restart();
      return false;
    }
    if (phase === 'ready') {
      phase = 'playing';
      acc = STEP_MS;
      lastTime = performance.now();
    }
    latched |= bit; // a quick tap between two ticks still registers
    wake();
    return true;
  }

  function restart() {
    runner = newRunner();
    prevX = runner.x;
    prevY = runner.y;
    runs = [];
    ticks = acc = squash = walk = flag = 0;
    facing = 1;
    overText = '';
    phase = 'ready';
    releaseAll();
    wake();
  }

  function stop(text: string) {
    phase = 'over';
    overText = text;
    releaseAll();
  }

  function step() {
    const mask = (heldMask() | latched) & 7;
    latched = 0;
    const last = runs.at(-1);
    if (last && last[0] === mask) {
      last[1]++;
    } else if (runs.length < MAX_RUNS) {
      runs.push([mask, 1]);
    } else {
      stop('Time for a fresh run');
      return;
    }

    prevX = runner.x;
    prevY = runner.y;
    tick(runner, mask, blocks);
    ticks++;

    if (prevY > runner.y && runner.vy === 0) squash = 4;
    else if (squash > 0) squash--;
    if (runner.x !== prevX && runner.vy === 0) walk++;
    const dir = (mask & RIGHT ? 1 : 0) - (mask & LEFT ? 1 : 0);
    if (dir) facing = dir;

    if (runner.won) finish();
    else if (ticks >= MAX_TICKS) stop('Out of time');
  }

  function frame(now: number) {
    raf = 0;
    if (disposed) return;
    if (phase === 'playing') {
      acc += Math.min(250, Math.max(0, now - lastTime));
      lastTime = now;
      let n = 0;
      while (phase === 'playing' && acc >= STEP_MS && n < 8) {
        step();
        acc -= STEP_MS;
        n++;
      }
      if (disposed) return;
      if (acc > STEP_MS) acc = STEP_MS;
      draw(now, Math.min(1, acc / STEP_MS));
    } else if (now - lastDraw >= 32 || phase === 'over') {
      draw(now, 1); // ambient scene runs at about 30 fps to save CPU
    }
    if (phase === 'ready' || phase === 'playing') raf = requestAnimationFrame(frame);
  }

  function finish() {
    if (disposed) return;
    phase = 'won';
    flag = 1;
    const moves = runs.map((r) => [r[0], r[1]]);
    draw(performance.now(), 1);
    cleanup();
    onWin(moves);
  }

  function cleanup() {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    while (offs.length) (offs.pop() as () => void)();
    releaseAll();
    for (let i = 0; i < controls.length; i++) controls[i][0].style.touchAction = savedTouch[i];
  }

  // ---- Input ---------------------------------------------------------------
  const isEditable = (t: EventTarget | null) =>
    t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  const isOurs = (t: EventTarget | null) =>
    t === canvas || controls.some(([el]) => t instanceof Node && el.contains(t));

  on<KeyboardEvent>(window, 'keydown', (e) => {
    if (disposed || e.altKey || e.ctrlKey || e.metaKey) return;
    const id = e.code || e.key;
    const bit = KEYS[e.code] || KEYS[e.key];
    if (!bit) return; // Tab and every other key are left alone
    const t = e.target;
    const unfocused = t === document.body || t === document.documentElement;
    if (!isOurs(t) && (isEditable(t) || (phase !== 'playing' && !unfocused))) return;
    e.preventDefault();
    if (e.repeat || heldKeys[id]) return;
    if (press(bit)) heldKeys[id] = bit;
  });

  on<KeyboardEvent>(window, 'keyup', (e) => {
    const id = e.code || e.key;
    if (heldKeys[id]) {
      delete heldKeys[id];
      e.preventDefault();
    }
  });

  const savedTouch = controls.map(([el]) => el.style.touchAction);
  for (let i = 0; i < controls.length; i++) {
    const el = controls[i][0], bit = controls[i][1];
    el.style.touchAction = 'none';
    on<PointerEvent>(el, 'pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      e.preventDefault();
      if (!press(bit)) return;
      heldPointers.set(e.pointerId, bit);
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* capture is optional */ }
    });
    const lift = (e: PointerEvent) => { heldPointers.delete(e.pointerId); };
    on(el, 'pointerup', lift);
    on(el, 'pointercancel', lift);
    on(el, 'lostpointercapture', lift);
    on(el, 'contextmenu', (e) => e.preventDefault());
  }

  on<PointerEvent>(canvas, 'pointerdown', () => {
    canvas.focus({ preventScroll: true });
    if (phase === 'over') restart();
  });
  on(window, 'blur', releaseAll);
  on(document, 'visibilitychange', () => {
    releaseAll();
    lastTime = performance.now(); // no catch-up burst after the tab returns
  });

  // ---- Drawing -------------------------------------------------------------
  function rr(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function paintBackground() {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const g = c.getContext('2d');
    if (!g) return c;
    let seed = 20231;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

    const sky = g.createLinearGradient(0, 0, 0, GROUND);
    sky.addColorStop(0, '#232650');
    sky.addColorStop(0.4, '#4e3b6e');
    sky.addColorStop(0.72, '#b9657a');
    sky.addColorStop(1, '#f3b27e');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, GROUND);

    for (let i = 0; i < 28; i++) {
      g.fillStyle = `rgba(255,244,220,${(0.25 + rnd() * 0.5).toFixed(2)})`;
      g.fillRect(Math.round(rnd() * W), Math.round(rnd() * 80), 1, 1);
    }

    const glow = g.createRadialGradient(408, 128, 4, 408, 128, 90);
    glow.addColorStop(0, 'rgba(255,220,160,0.55)');
    glow.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = glow;
    g.fillRect(300, 30, 220, 150);
    g.fillStyle = '#ffe1ad';
    g.beginPath();
    g.arc(408, 128, 19, 0, Math.PI * 2);
    g.fill();

    const hill = (base: number, amp: number, freq: number, ph: number, color: string) => {
      g.beginPath();
      g.moveTo(0, H);
      for (let x = 0; x <= W; x += 8) g.lineTo(x, base - amp * Math.sin(x * freq + ph));
      g.lineTo(W, H);
      g.closePath();
      g.fillStyle = color;
      g.fill();
    };
    hill(132, 10, 0.012, 1, '#8d6089');
    hill(146, 12, 0.009, 3, '#5d557f');

    // Cottage with a warm window on the middle hill
    const cy = Math.round(146 - 12 * Math.sin(286 * 0.009 + 3));
    g.fillStyle = '#2b3a50';
    g.fillRect(280, cy - 10, 16, 10);
    g.fillStyle = '#22304a';
    g.beginPath();
    g.moveTo(277, cy - 9);
    g.lineTo(288, cy - 17);
    g.lineTo(299, cy - 9);
    g.fill();
    g.fillStyle = '#ffcf73';
    g.fillRect(285, cy - 7, 4, 4);

    hill(160, 8, 0.016, 0.5, '#3c5869');
    const trees = [70, 455];
    for (let i = 0; i < trees.length; i++) {
      const tx = trees[i], ty = 160 - 8 * Math.sin(tx * 0.016 + 0.5);
      g.fillStyle = '#26323e';
      g.fillRect(tx - 1, ty - 6, 2, 8);
      g.fillStyle = '#2d4656';
      g.beginPath();
      g.arc(tx, ty - 11, 7, 0, Math.PI * 2);
      g.fill();
    }

    // Grass, the dirt path, pebbles and tufts
    g.fillStyle = '#36573f';
    g.fillRect(0, GROUND, W, H - GROUND);
    g.fillStyle = '#c69567';
    g.fillRect(0, GROUND, W, 8);
    g.fillStyle = '#e2b885';
    g.fillRect(0, GROUND, W, 1);
    g.fillStyle = '#a97d55';
    for (let i = 0; i < 40; i++) g.fillRect(Math.round(rnd() * W), GROUND + 2 + Math.round(rnd() * 5), 2, 1);
    g.strokeStyle = '#2c4a35';
    g.lineWidth = 1;
    for (let i = 0; i < 34; i++) {
      const x = rnd() * W, y = GROUND + 14 + rnd() * (H - GROUND - 18);
      g.beginPath();
      g.moveTo(x - 2, y - 3);
      g.lineTo(x, y);
      g.lineTo(x + 2, y - 3);
      g.stroke();
    }
    return c;
  }

  function drawAmbient(now: number) {
    for (let i = 0; i < TWINKLES.length; i += 2) {
      const a = 0.2 + 0.5 * (0.5 + 0.5 * Math.sin(now / 650 + i * 1.3));
      ctx.fillStyle = `rgba(255,243,214,${a.toFixed(2)})`;
      ctx.fillRect(TWINKLES[i] - 0.5, TWINKLES[i + 1] - 2, 1, 4);
      ctx.fillRect(TWINKLES[i] - 2, TWINKLES[i + 1] - 0.5, 4, 1);
    }
    ctx.fillStyle = 'rgba(255,212,196,0.18)';
    for (let i = 0; i < 2; i++) {
      const cx = ((now * (0.004 + i * 0.002) + i * 290) % (W + 120)) - 60, cy = 56 + i * 26;
      ctx.beginPath();
      const puffs = [0, 0, 22, 6, 9, -4, 12, 6, -8, -2, 9, 5];
      for (let p = 0; p < puffs.length; p += 4) {
        ctx.moveTo(cx + puffs[p] + puffs[p + 2], cy + puffs[p + 1]);
        ctx.ellipse(cx + puffs[p], cy + puffs[p + 1], puffs[p + 2], puffs[p + 3], 0, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  function drawParcel(cx: number, done: boolean) {
    const x = cx - PARCEL_HALF, y = GROUND - PARCEL_TOP, w = PARCEL_HALF * 2, h = PARCEL_TOP;
    ctx.fillStyle = 'rgba(24,18,36,0.25)';
    ctx.beginPath();
    ctx.ellipse(cx, GROUND + 2, 15, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b5793f';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#cb9054';
    ctx.fillRect(x, y, w, 3);
    ctx.strokeStyle = '#8a5428';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, y + 8.5); ctx.lineTo(x + w, y + 8.5);
    ctx.moveTo(x, y + 15.5); ctx.lineTo(x + w, y + 15.5);
    ctx.stroke();
    // Twine and a little bow
    ctx.strokeStyle = '#ecd9a8';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(cx, y); ctx.lineTo(cx, y + h);
    ctx.moveTo(cx, y); ctx.quadraticCurveTo(cx - 6, y - 5, cx - 1, y - 1);
    ctx.moveTo(cx, y); ctx.quadraticCurveTo(cx + 6, y - 5, cx + 1, y - 1);
    ctx.stroke();
    ctx.strokeStyle = '#5c3517';
    ctx.strokeRect(x + 0.75, y + 0.75, w - 1.5, h - 1.5);
    // Stamp label: red until cleared, then green with a check mark
    ctx.fillStyle = '#f6eedb';
    ctx.fillRect(x + 3, y + 10, 8, 8);
    ctx.fillStyle = done ? '#4f9d69' : '#d4463b';
    ctx.fillRect(x + 4, y + 11, 6, 6);
    if (done) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x + 5, y + 14); ctx.lineTo(x + 6.5, y + 15.5); ctx.lineTo(x + 9, y + 12.5);
      ctx.stroke();
    }
  }

  function drawMailbox(now: number) {
    const x = MAILBOX_X;
    if (runner.cleared >= parcels.length) {
      const a = 0.22 + 0.12 * Math.sin(now / 300);
      ctx.fillStyle = `rgba(255,224,150,${a.toFixed(2)})`;
      ctx.beginPath();
      ctx.ellipse(x, GROUND + 2, 20, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#5b3d27';
    ctx.fillRect(x - 2, GROUND - 28, 4, 28);
    rr(ctx, x - 14, GROUND - 46, 28, 18, 8);
    ctx.fillStyle = '#2f5f8f';
    ctx.fill();
    ctx.fillRect(x - 14, GROUND - 36, 28, 8);
    ctx.fillStyle = '#4b80b4';
    ctx.fillRect(x - 9, GROUND - 44, 18, 2);
    ctx.strokeStyle = '#1d3550';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x - 14, GROUND - 38, 28, 10);
    rr(ctx, x - 16, GROUND - 45, 5, 17, 2); // cream front door
    ctx.fillStyle = '#efe3c8';
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#f6eedb';
    ctx.fillRect(x - 2, GROUND - 42, 7, 7); // stamp sticker
    ctx.fillStyle = '#d4463b';
    ctx.fillRect(x - 1, GROUND - 41, 5, 5);

    // The red flag swings up once both parcels are cleared
    flag += ((runner.cleared >= parcels.length ? 1 : 0) - flag) * 0.12;
    ctx.save();
    ctx.translate(x + 11, GROUND - 34);
    ctx.rotate(-flag * Math.PI / 2 + Math.sin(now / 260) * 0.05 * flag);
    ctx.fillStyle = '#3a2a22';
    ctx.fillRect(-1, -1, 15, 2);
    ctx.fillStyle = '#e3342f';
    ctx.fillRect(8, -7, 7, 6);
    ctx.fillStyle = '#ff7a6b';
    ctx.fillRect(8, -7, 7, 1.5);
    ctx.strokeStyle = '#8f1d19';
    ctx.lineWidth = 1;
    ctx.strokeRect(8.5, -6.5, 6, 5);
    ctx.restore();
  }

  function drawCourier(x: number, y: number, now: number) {
    let floor = 0;
    for (let i = 0; i < parcels.length; i++) {
      if (y >= PARCEL_TOP && Math.abs(x - parcels[i]) < REACH) floor = PARCEL_TOP;
    }
    const lift = Math.min(y - floor, 45);
    const air = runner.vy !== 0 || lift > 0;
    const moving = runner.x !== prevX;
    const k = squash / 4;
    const feet = GROUND - y;

    ctx.fillStyle = `rgba(24,18,36,${(0.3 - lift / 200).toFixed(2)})`;
    ctx.beginPath();
    ctx.ellipse(x, GROUND - floor + 1, 8 - lift / 9, 2, 0, 0, Math.PI * 2);
    ctx.fill();

    if (k > 0) {
      ctx.fillStyle = `rgba(246,226,196,${(k * 0.6).toFixed(2)})`;
      for (let side = -1; side <= 1; side += 2) {
        ctx.beginPath();
        ctx.arc(x + side * (9 + (1 - k) * 5), GROUND - floor - 1.5, 1.5 + (1 - k) * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    ctx.strokeStyle = '#4a2f28';
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    const swing = !air && moving ? Math.sin(walk * 1.4) * 2.2 : 0;
    ctx.beginPath();
    if (air) {
      ctx.moveTo(x - 3, feet - 4); ctx.lineTo(x - 4.5, feet - 1.5);
      ctx.moveTo(x + 3, feet - 4); ctx.lineTo(x + 1.5, feet - 1);
    } else {
      ctx.moveTo(x - 3, feet - 4); ctx.lineTo(x - 3 + swing, feet);
      ctx.moveTo(x + 3, feet - 4); ctx.lineTo(x + 3 - swing, feet);
    }
    ctx.stroke();

    const bob = !air && !moving ? Math.sin(now / 320) * 0.6 : 0;
    ctx.save();
    ctx.translate(x, feet - 4 + bob);
    ctx.scale(facing * (1 + 0.2 * k - (air ? 0.06 : 0)), 1 - 0.2 * k + (air ? 0.08 : 0));
    rr(ctx, -8, -12, 16, 12, 2);
    ctx.fillStyle = '#fff6e6';
    ctx.fill();
    ctx.strokeStyle = '#5a382c';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-7, -11.4); ctx.lineTo(0, -6.5); ctx.lineTo(7, -11.4);
    ctx.strokeStyle = '#c29a78';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#d9483c';
    ctx.fillRect(3, -10.5, 3.5, 3.5);
    ctx.fillStyle = '#35241f';
    if (now % 3600 < 120) {
      ctx.fillRect(-1.6, -4.4, 2.2, 0.9);
      ctx.fillRect(2.4, -4.4, 2.2, 0.9);
    } else {
      ctx.beginPath();
      ctx.moveTo(0.6, -4); ctx.arc(-0.5, -4, 1.1, 0, Math.PI * 2);
      ctx.moveTo(4.6, -4); ctx.arc(3.5, -4, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = 'rgba(232,112,112,0.55)';
    ctx.beginPath();
    ctx.arc(5.6, -2.2, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function banner(title: string, sub: string) {
    ctx.font = `700 14px ${FONT}`;
    const tw = ctx.measureText(title).width;
    ctx.font = `500 12px ${FONT}`;
    const sw = sub ? ctx.measureText(sub).width : 0;
    const w = Math.max(tw, sw) + 32, h = sub ? 46 : 30, x = (W - w) / 2, y = 54;
    rr(ctx, x, y, w, h, 10);
    ctx.fillStyle = 'rgba(30,22,52,0.82)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,226,180,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff7ea';
    ctx.font = `700 14px ${FONT}`;
    ctx.fillText(title, W / 2, y + 15);
    if (sub) {
      ctx.fillStyle = '#f2d4ad';
      ctx.font = `500 12px ${FONT}`;
      ctx.fillText(sub, W / 2, y + 32);
    }
  }

  function drawHud() {
    // Postage-stamp badge with perforated edges
    const bx = 10, by = 10, bw = 112, bh = 24;
    ctx.fillStyle = '#f6eedc';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = '#2a2852';
    ctx.beginPath();
    for (let i = bx + 4; i < bx + bw; i += 6) {
      ctx.moveTo(i + 1.6, by); ctx.arc(i, by, 1.6, 0, Math.PI * 2);
      ctx.moveTo(i + 1.6, by + bh); ctx.arc(i, by + bh, 1.6, 0, Math.PI * 2);
    }
    for (let j = by + 4; j < by + bh; j += 6) {
      ctx.moveTo(bx + 1.6, j); ctx.arc(bx, j, 1.6, 0, Math.PI * 2);
      ctx.moveTo(bx + bw + 1.6, j); ctx.arc(bx + bw, j, 1.6, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.strokeStyle = '#c9463d';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(bx + 4.5, by + 4.5, bw - 9, bh - 9);
    ctx.setLineDash([]);
    ctx.fillStyle = '#4a2c28';
    ctx.font = `700 12px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const all = runner.cleared >= parcels.length;
    ctx.fillText(all ? 'To the mailbox →' : `Parcels ${runner.cleared}/${parcels.length}`, bx + bw / 2, by + bh / 2 + 0.5);

    if (phase === 'playing' || phase === 'over') {
      const secs = Math.max(0, Math.ceil((MAX_TICKS - ticks) / 30));
      rr(ctx, W - 56, 12, 44, 20, 10);
      ctx.fillStyle = 'rgba(30,22,52,0.6)';
      ctx.fill();
      ctx.fillStyle = secs <= 10 ? '#ffb3a1' : '#fff7ea';
      ctx.font = `600 12px ${FONT}`;
      ctx.fillText(`${secs}s`, W - 34, 22.5);
    }

    if (phase === 'over') banner(overText, 'Press any control to try again');
  }

  function draw(now: number, alpha: number) {
    lastDraw = now;
    ctx.drawImage(background, 0, 0);
    drawAmbient(now);
    drawMailbox(now);
    for (let i = 0; i < parcels.length; i++) drawParcel(parcels[i], i < runner.cleared);
    drawCourier(prevX + (runner.x - prevX) * alpha, prevY + (runner.y - prevY) * alpha, now);
    drawHud();
  }

  draw(performance.now(), 1);
  wake();
  return cleanup;
}

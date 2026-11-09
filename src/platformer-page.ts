import { mountGame, newRunner, tick } from "./platformer-game.js";

export function platformerPage(nonce: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mailbox run · Clefmail</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-content:center;background:#f6f3ea;color:#202c3c;font:17px/1.5 system-ui,sans-serif}
main{width:min(94vw,640px);padding:clamp(16px,4vw,36px);background:#fffdf6;border:2px solid #2d3946;border-radius:18px;box-shadow:5px 6px #d8d6c9}
h1{font:700 clamp(28px,7vw,46px)/1.1 Georgia,serif;margin:0}p{margin:14px 0}canvas{width:100%;height:auto;display:block;border-radius:9px}
.controls{display:flex;gap:10px;margin:14px 0}.controls button{flex:1;touch-action:none;user-select:none}
button{padding:10px 14px;font:inherit;border:1px solid #263748;border-radius:8px;background:#ffdf98;color:#182735;cursor:pointer}
button:focus-visible,canvas:focus-visible{outline:3px solid #1d6478;outline-offset:3px}button:disabled{opacity:.55}
</style></head><body><main><h1>Mailbox run</h1>
<p>Jump over both parcels and reach the mailbox to verify your email. Move with ← → or A and D. Jump with ↑ or Space.</p>
<canvas id="game" width="560" height="210" tabindex="0" aria-label="Mailbox run game">This game needs a browser with canvas support.</canvas>
<div class="controls"><button id="left" aria-label="Move left">←</button><button id="right" aria-label="Move right">→</button><button id="jump">Jump ↑</button></div>
<p id="status" role="status" aria-live="polite">Loading your course…</p><button id="retry" hidden>Play again</button></main>
<script nonce="${nonce}">
const newRunner = ${newRunner.toString()};
const tick = ${tick.toString()};
const mountGame = ${mountGame.toString()};
const parts = location.hash.slice(1).split('/');
history.replaceState(null, '', '/verify');
const statusLine = document.querySelector('#status'), retry = document.querySelector('#retry');
const link = {account:parts[0],sender:parts[1],token:parts[2]};
const post = (path, body) => fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
let stop;
async function start() {
  stop?.(); retry.hidden = true; statusLine.textContent = 'Loading your course…';
  try {
    const response = await post('/verify/game',link);
    if (!response.ok) throw new Error(await response.text());
    const course = await response.json();
    statusLine.textContent = 'Ready when you are.';
    stop = mountGame(course.blocks, async moves => {
      statusLine.textContent = 'Checking your run…';
      try {
        const result = await post('/verify',{...link,challenge:{ticket:course.ticket,moves}});
        statusLine.textContent = await result.text();
        retry.hidden = result.ok;
      } catch { statusLine.textContent = 'Connection interrupted. Play again to retry.'; retry.hidden = false; }
    });
  } catch (err) { statusLine.textContent = err.message || 'Could not load the course.'; retry.hidden = false; }
}
retry.addEventListener('click',start);
if (parts.length === 3 && /^[a-z][a-z0-9_-]{0,49}$/.test(parts[0]) && /^[a-f0-9]{64}$/.test(parts[1]) && /^[a-zA-Z0-9_-]{43}$/.test(parts[2])) start();
else statusLine.textContent = 'Open the complete verification link from your email.';
</script></body></html>`;
}

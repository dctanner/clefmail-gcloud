import { mountGame, newRunner, tick } from "./platformer-game.js";

export function platformerPage(nonce: string, mode: "practice" | "verify" = "verify") {
  const practice = mode === "practice";
  const title = practice ? "Try email verification" : "Let your email through";
  const intro = practice
    ? "Try the check that senders complete before their email reaches the recipient’s inbox."
    : "Your email is on hold. Complete this short game to confirm you’re human so we can deliver it to the recipient’s inbox.";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Clefmail</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;padding:clamp(24px,9vh,88px) 16px;background:#f5f7fb;color:#18233a;font:16px/1.55 system-ui,sans-serif}
main{max-width:604px;margin:auto;padding:clamp(20px,5vw,32px);background:#fff;border:1px solid #dae0eb;border-radius:16px}
h1{font-size:clamp(25px,5vw,32px);line-height:1.2;letter-spacing:-.025em;margin:0}h1:focus{outline:none}p{margin:10px 0 0}
#intro,#status{color:#46546a}#status:empty{margin:0}#course{margin-top:24px}
canvas{display:block;width:100%;height:auto;border-radius:8px;background:#f5f7fb}
.instructions{font-size:15px;margin:0 0 10px}.keys{color:#46546a;font-size:14px;margin:10px 0 0}
.controls{display:flex;gap:8px;margin-top:12px}.controls button{flex:1;touch-action:none;user-select:none;-webkit-user-select:none}
button{min-height:44px;font:600 15px/1.3 system-ui,sans-serif;cursor:pointer;padding:8px 16px;border-radius:8px;border:1px solid #cbd4e2;background:#fff;color:#24324a}
button:active{background:#edf1f7}button:focus-visible,canvas:focus-visible{outline:3px solid #204ad5;outline-offset:3px}
#retry{margin-top:16px;border:0;background:#204ad5;color:white}
@media(pointer:coarse){.keys{display:none}}
</style></head><body><main><h1 id="title" tabindex="-1">${title}</h1><p id="intro">${intro}</p>
<div id="course" hidden><p class="instructions">Jump over both parcels and reach the mailbox.</p>
<canvas id="game" width="560" height="210" tabindex="0" aria-label="Mailbox run game">This game needs a browser with canvas support.</canvas>
<div class="controls"><button id="left" aria-label="Move left">←</button><button id="right" aria-label="Move right">→</button><button id="jump">Jump</button></div>
<p class="keys">Move with ← → or A and D. Jump with ↑ or Space.</p></div>
<p id="status" role="status">Loading the game…</p><button id="retry" hidden>Play again</button></main>
<script nonce="${nonce}">
const newRunner = ${newRunner.toString()};
const tick = ${tick.toString()};
const mountGame = ${mountGame.toString()};
const statusLine = document.querySelector('#status'), retry = document.querySelector('#retry');
const heading = document.querySelector('#title'), intro = document.querySelector('#intro'), coursePanel = document.querySelector('#course');
function showResult(title, message) {
  coursePanel.hidden = true;
  intro.hidden = true;
  heading.textContent = title;
  statusLine.textContent = message;
  heading.focus();
}
${practice ? practiceScript : verificationScript}
</script></body></html>`;
}

const practiceScript = `
function start(event) {
  retry.hidden = true;
  heading.textContent = 'Try email verification';
  intro.hidden = false;
  coursePanel.hidden = false;
  statusLine.textContent = '';
  if (event) document.querySelector('#game').focus({preventScroll:true});
  const blocks = [130, 330].map(x => x + Math.floor(Math.random() * 51));
  mountGame(blocks, () => {
    showResult('Practice run complete', 'With a sender verification link, completing this game delivers your held email to the recipient’s inbox.');
    retry.hidden = false;
  });
}
retry.addEventListener('click', start);
start();`;

const verificationScript = `const parts = location.hash.slice(1).split('/');
history.replaceState(null, '', '/verify');
const link = {account:parts[0],sender:parts[1],token:parts[2]};
const post = (path, body) => fetch(path, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
let stop;
async function start() {
  stop?.(); retry.hidden = true; statusLine.textContent = 'Loading your course…';
  try {
    const response = await post('/verify/game',link);
    if (!response.ok) throw new Error(await response.text());
    const course = await response.json();
    statusLine.textContent = '';
    coursePanel.hidden = false;
    stop = mountGame(course.blocks, async moves => {
      coursePanel.hidden = true;
      statusLine.textContent = 'Verifying your run…';
      try {
        const result = await post('/verify',{...link,challenge:{ticket:course.ticket,moves}});
        const message = await result.text();
        if (result.ok) showResult('Verification complete', message);
        else { statusLine.textContent = message; retry.hidden = false; }
      } catch { statusLine.textContent = 'Connection interrupted. Play again to retry.'; retry.hidden = false; }
    });
  } catch (err) { statusLine.textContent = err.message || 'Could not load the course.'; retry.hidden = false; }
}
retry.addEventListener('click',start);
if (parts.length === 3 && /^[a-z][a-z0-9_-]{0,49}$/.test(parts[0]) && /^[a-f0-9]{64}$/.test(parts[1]) && /^[a-zA-Z0-9_-]{43}$/.test(parts[2])) start();
else statusLine.textContent = 'Open the complete verification link from your email.';`;

// Talks to a game started by TyranoPatcher through its DevTools port (Node 22+).
//   node cdp.mjs <port> eval "<js expression>"      prints the result as JSON (promises awaited)
//   node cdp.mjs <port> key <keyCode> [nokeyup]     real key press: keydown, then keyup unless "nokeyup"
//   node cdp.mjs <port> click <x> <y>               real left click at page coordinates
//   node cdp.mjs <port> shot <file.png>             screenshot
//   node cdp.mjs <port> console [seconds]           prints console output for a while (default 5)
// Example: node cdp.mjs 50123 eval "__tyranoPatcher.version"
import fs from 'fs';

const [port, cmd, ...args] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find(t => t.type === 'page');
if (!page) throw new Error('no page target on port ' + port);

const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = {};
const listeners = [];
ws.onmessage = m => {
  const d = JSON.parse(m.data);
  if (d.id && pending[d.id]) { pending[d.id](d); delete pending[d.id]; }
  else for (const l of listeners) l(d);
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
const send = (method, params = {}) => new Promise(res => {
  const id = ++nextId;
  pending[id] = res;
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

const KEYS = { 8: ['Backspace', 'Backspace'], 13: ['Enter', 'Enter'], 17: ['Control', 'ControlLeft'],
  32: [' ', 'Space'], 33: ['PageUp', 'PageUp'], 91: ['Meta', 'MetaLeft'], 92: ['Meta', 'MetaRight'] };

switch (cmd) {
  case 'eval': {
    const r = await send('Runtime.evaluate', { expression: args.join(' '), returnByValue: true, awaitPromise: true });
    const res = r.result;
    console.log(res.exceptionDetails ? 'EXCEPTION ' + JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails)
      : JSON.stringify(res.result.value));
    break;
  }
  case 'key': {
    const code = Number(args[0]);
    const [key, keyCodeName] = KEYS[code] || [String.fromCharCode(code), ''];
    const p = { windowsVirtualKeyCode: code, key, code: keyCodeName };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...p });
    if (args[1] !== 'nokeyup') { await sleep(50); await send('Input.dispatchKeyEvent', { type: 'keyUp', ...p }); }
    break;
  }
  case 'click': {
    const p = { x: Number(args[0]), y: Number(args[1]), button: 'left', clickCount: 1 };
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p });
    await sleep(50);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p });
    break;
  }
  case 'shot': {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(args[0], Buffer.from(r.result.data, 'base64'));
    console.log('saved', args[0]);
    break;
  }
  case 'console': {
    listeners.push(d => {
      if (d.method === 'Runtime.consoleAPICalled') console.log(d.params.type, d.params.args.map(a => a.value ?? a.description).join(' '));
      if (d.method === 'Runtime.exceptionThrown') console.log('EXCEPTION', d.params.exceptionDetails.exception?.description);
    });
    await send('Runtime.enable');
    await sleep(1000 * (Number(args[0]) || 5));
    break;
  }
  default:
    console.error('commands: eval, key, click, shot, console');
    process.exitCode = 2;
}
ws.close();

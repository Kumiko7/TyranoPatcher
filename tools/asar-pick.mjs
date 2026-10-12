// Extracts files from an Electron app.asar without unpacking all of it.
//   node asar-pick.mjs <app.asar> <outDir> <regex>     e.g. '(KeyConfig|kag\.key_mouse)\.js$'
//   node asar-pick.mjs <app.asar> - <regex>            prints the first match to stdout
import fs from 'fs';
import path from 'path';

const [asar, out, re] = process.argv.slice(2);
if (!re) {
  console.error('usage: node asar-pick.mjs <app.asar> <outDir|-> <regex>');
  process.exit(2);
}
const fd = fs.openSync(asar, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonLen = head.readUInt32LE(12);
const json = Buffer.alloc(jsonLen);
fs.readSync(fd, json, 0, jsonLen, 16);
const base = 8 + headerSize;
const rx = new RegExp(re, 'i');

(function walk(node, dir) {
  for (const [name, n] of Object.entries(node.files || {})) {
    const p = dir ? dir + '/' + name : name;
    if (n.files) { walk(n, p); continue; }
    if (!rx.test(p) || n.unpacked) continue;
    const buf = Buffer.alloc(n.size);
    fs.readSync(fd, buf, 0, n.size, base + Number(n.offset));
    if (out === '-') { process.stdout.write(buf); process.exit(0); }
    const dst = path.join(out, p);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, buf);
    console.log(p, n.size);
  }
})(JSON.parse(json.toString()), '');

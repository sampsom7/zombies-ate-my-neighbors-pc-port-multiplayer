// node web/test_wasm.mjs rom.sfc -- the same run as web/native_test.c, on
// zamn.wasm: the final hash must match the native build's, and two separate
// instances fed the same inputs must agree frame for frame (which is what
// netplay assumes of two browsers).
import { readFileSync } from "node:fs";
import { Machine, FLAG } from "./zamn-core.js";

const rom = new Uint8Array(readFileSync(process.argv[2]));
const mod = await WebAssembly.compile(readFileSync(new URL("./zamn.wasm", import.meta.url)));
const flags = FLAG.SKIP_INTRO | FLAG.TWIN_STICK | FLAG.EFFECT_OVERLAY |
              FLAG.ALL_MONSTER_SOUNDS | FLAG.STEADY_RADAR;

function script(f, port) {
  if (f < 400) return (f % 40 < 4 && port === 0) ? (1 << 3) : 0;
  if (f < 420 && port === 1) return (f % 10 < 3) ? (1 << 3) : 0;
  const phase = (Math.floor(f / 60) + port) % 4;
  let b = 1 << (4 + phase);
  if (f % 8 < 3) b |= 1 << 1;
  return b;
}

const a = await Machine.create(mod), b = await Machine.create(mod);
if (a.init(rom, flags, 0) || b.init(rom, flags, 0)) throw new Error("init failed");
const t0 = performance.now();
let state = null, at = -1;
for (let i = 0; i < 3000; i++) {
  a.frame(script(i, 0), script(i, 1));
  a.audio(800);
  if (i === 1600) { state = a.saveState(); at = i; }
}
const ms = (performance.now() - t0) / 3000;
console.log(`wasm: hash ${a.hash().toString(16)} after 3000 frames, ${ms.toFixed(2)} ms/frame`);
// The second instance joins late, from the first one's state, as a netplay guest does.
for (let i = 0; i <= at; i++) { b.frame(0, 0); b.audio(800); }
console.log("load:", b.loadState(state));
for (let i = at + 1; i < 3000; i++) { b.frame(script(i, 0), script(i, 1)); b.audio(800); }
console.log(`joined instance: hash ${b.hash().toString(16)} ${b.hash() === a.hash() ? "MATCH" : "DIFFERENT"}`);

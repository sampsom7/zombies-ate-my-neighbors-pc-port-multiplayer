// The page: cartridge, picture, sound, controls, and online play.
//
// Online play is lockstep. The game is deterministic, so the two browsers send
// each other only their controller state, one word per frame, and each runs
// frame N once it has both players' words for N. Each side's input is
// scheduled `delay` frames ahead, which hides the network's latency; the delay
// is picked from the measured round trip when the session starts. To begin,
// the host sends a save state of its machine, so a friend can join a game
// already in progress, and every two seconds both sides compare a hash of
// the game's memory. If they ever disagree, the host sends its state again.
//
// Connections go peer to peer over WebRTC, set up through PeerJS's free public
// broker (or the one in server.mjs, when the page is served from there). The
// host is always player 1 and the guest player 2.

import { Machine, FLAG, CHEATS, BTN, AIM_SHIFT, CYCLE_SHIFT, crc32 } from "./zamn-core.js";
import { Peer, PUBLIC_BROKER } from "./net.js";

const PROTO = 1;
const FPS = 60.0988;        // the SNES's NTSC frame rate
const FRAME_MS = 1000 / FPS;
const HASH_EVERY = 120;
const ID_PREFIX = "zamn-nbr-";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("zamn." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("zamn." + k, JSON.stringify(v)); } catch {} },
};

// --- IndexedDB, for the cartridge and the quick save ----------------------------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("zamn-web", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("files");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function fileGet(key) {
  try {
    const db = await idb();
    return await new Promise((res) => {
      const q = db.transaction("files").objectStore("files").get(key);
      q.onsuccess = () => res(q.result || null);
      q.onerror = () => res(null);
    });
  } catch { return null; }
}
async function filePut(key, val) {
  try {
    const db = await idb();
    db.transaction("files", "readwrite").objectStore("files").put(val, key);
  } catch {}
}

// --- state ------------------------------------------------------------------------
let wasmModule = null, buildId = 0;
let rom = null, romCrc = 0;
let machine = null;
let paused = false;
let toastTimer = 0;

const KNOWN_SHA1 = "1be79496d7a38b293d6a5d9fba0e16f3cb37d5ff";

const settings = Object.assign({
  skipIntro: true, twinStick: true, effectOverlay: true, allMonsterSounds: true,
  steadyRadar: true, redBlood: false, cheats: 0, volume: 80, sharp: true,
}, store.get("settings", {}));

function flagsOf(s) {
  return (s.skipIntro ? FLAG.SKIP_INTRO : 0) | (s.twinStick ? FLAG.TWIN_STICK : 0) |
         (s.effectOverlay ? FLAG.EFFECT_OVERLAY : 0) | (s.allMonsterSounds ? FLAG.ALL_MONSTER_SOUNDS : 0) |
         (s.steadyRadar ? FLAG.STEADY_RADAR : 0) | (s.redBlood ? FLAG.RED_BLOOD : 0);
}

function toast(text, ms = 2600) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// --- the picture --------------------------------------------------------------------
const canvas = $("screen");
const ctx = canvas.getContext("2d", { alpha: false });
const image = ctx.createImageData(256, 224);
function draw() {
  if (!machine) return;
  image.data.set(machine.pixels());
  ctx.putImageData(image, 0, 0);
}

// --- sound --------------------------------------------------------------------------
// A ring buffer in an AudioWorklet, fed a frame at a time. How full it is
// comes back every few blocks, and the number of samples asked of the machine
// each frame is nudged to hold it near `target`.
const audio = { ctx: null, node: null, gain: null, rate: 48000, queued: 0, target: 0, ok: false };
const WORKLET = `
class Ring extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(48000 * 2); this.r = 0; this.w = 0; this.n = 0; this.tick = 0;
    this.port.onmessage = (e) => {
      const d = e.data, cap = this.buf.length;
      if (d === "flush") { this.r = this.w = this.n = 0; return; }
      for (let i = 0; i < d.length && this.n < cap; i++) { this.buf[this.w] = d[i]; this.w = (this.w + 1) % cap; this.n++; }
    };
  }
  process(_, outputs) {
    const L = outputs[0][0], R = outputs[0][1] || outputs[0][0], cap = this.buf.length;
    for (let i = 0; i < L.length; i++) {
      if (this.n >= 2) {
        L[i] = this.buf[this.r]; R[i] = this.buf[(this.r + 1) % cap];
        this.r = (this.r + 2) % cap; this.n -= 2;
      } else { L[i] = R[i] = 0; }
    }
    if ((++this.tick & 3) === 0) this.port.postMessage(this.n >> 1);
    return true;
  }
}
registerProcessor("zamn-ring", Ring);`;

async function audioStart() {
  if (audio.ctx) { if (audio.ctx.state !== "running") await audio.ctx.resume().catch(() => {}); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    audio.ctx = new AC({ latencyHint: "interactive" });
    audio.rate = audio.ctx.sampleRate;
    audio.target = Math.round(audio.rate * 0.07);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: "application/javascript" }));
    await audio.ctx.audioWorklet.addModule(url);
    audio.node = new AudioWorkletNode(audio.ctx, "zamn-ring", { outputChannelCount: [2] });
    audio.node.port.onmessage = (e) => { audio.queued = e.data; };
    audio.gain = audio.ctx.createGain();
    audio.gain.gain.value = settings.volume / 100;
    audio.node.connect(audio.gain).connect(audio.ctx.destination);
    audio.ok = true;
  } catch (err) {
    console.warn("no audio:", err);
    audio.ok = false;
  }
}

function audioFrame() {
  if (!machine) return;
  const base = audio.rate / FPS;
  if (!audio.ok || audio.ctx.state !== "running") { machine.audio(Math.round(base)); return; }
  if (audio.queued > audio.target * 4) { machine.audio(Math.round(base)); return; } // backlog: drop
  const err = (audio.target - audio.queued) / audio.target;
  const count = Math.round(base * (1 + Math.max(-0.01, Math.min(0.01, err * 0.01))));
  const s = machine.audio(count);
  const f = new Float32Array(s.length);
  for (let i = 0; i < s.length; i++) f[i] = s[i] / 32768;
  audio.node.port.postMessage(f, [f.buffer]);
  audio.queued += count;
}

// --- controls -------------------------------------------------------------------------
const KEYMAP = {
  ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT,
  KeyZ: BTN.B, KeyX: BTN.A, KeyA: BTN.Y, KeyS: BTN.X, KeyQ: BTN.L, KeyW: BTN.R,
  Enter: BTN.START, ShiftRight: BTN.SELECT, Backspace: BTN.SELECT,
};
// Cycling, which the SNES has no buttons for: next/previous weapon and item.
const KEYCYCLE = { KeyV: 0, KeyC: 1, KeyF: 2, KeyD: 3 };
const keysDown = new Set();

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code in KEYMAP || e.code in KEYCYCLE) { keysDown.add(e.code); e.preventDefault(); return; }
  if (e.repeat) return;
  if (e.code === "F5") { e.preventDefault(); quickSave(); }
  else if (e.code === "F9") { e.preventDefault(); quickLoad(); }
  else if (e.code === "F11" || (e.code === "Enter" && e.altKey)) { e.preventDefault(); toggleFullscreen(); }
  else if (e.code === "KeyP") togglePause();
});
window.addEventListener("keyup", (e) => keysDown.delete(e.code));
window.addEventListener("blur", () => keysDown.clear());

function keyboardWord() {
  let w = 0, c = 0;
  for (const k of keysDown) {
    if (k in KEYMAP) w |= 1 << KEYMAP[k];
    else if (k in KEYCYCLE) c |= 1 << KEYCYCLE[k];
  }
  return { w, c };
}

// Standard-mapping gamepads, bound as the desktop build binds them.
const PAD_BTN = { 0: BTN.B, 1: BTN.A, 2: BTN.Y, 3: BTN.X, 8: BTN.SELECT, 9: BTN.START,
                  10: BTN.R, 17: BTN.L, 12: BTN.UP, 13: BTN.DOWN, 14: BTN.LEFT, 15: BTN.RIGHT };
// Right shoulder/left shoulder: next/previous item. Triggers: next/previous weapon.
const PAD_CYCLE = { 7: 0, 6: 1, 5: 2, 4: 3 };

// A stick as the four D-pad bits, snapped to eight directions.
function stickBits(x, y) {
  if (Math.hypot(x, y) < 0.4) return 0;
  const oct = Math.round(Math.atan2(y, x) / (Math.PI / 4));
  const dirs = { 0: [BTN.RIGHT], 1: [BTN.RIGHT, BTN.DOWN], 2: [BTN.DOWN], 3: [BTN.LEFT, BTN.DOWN],
                 4: [BTN.LEFT], "-4": [BTN.LEFT], "-3": [BTN.LEFT, BTN.UP], "-2": [BTN.UP], "-1": [BTN.RIGHT, BTN.UP] };
  let m = 0;
  for (const b of dirs[oct]) m |= 1 << b;
  return m;
}
// ...and as the aim nibble the input word carries (up, down, left, right).
function aimNibble(dpad) {
  return ((dpad >> BTN.UP) & 1) | (((dpad >> BTN.DOWN) & 1) << 1) |
         (((dpad >> BTN.LEFT) & 1) << 2) | (((dpad >> BTN.RIGHT) & 1) << 3);
}

// A d-pad reported as one "hat" axis, as many SNES-style USB pads do when the
// browser has no standard mapping for them: eight positions from -1 (up)
// clockwise in steps of 2/7, and a value past 1 when centred.
function hatBits(v) {
  if (v === undefined || Math.abs(v) > 1.05) return 0;
  const pos = Math.round((v + 1) / (2 / 7)) & 7;
  const dirs = [[BTN.UP], [BTN.UP, BTN.RIGHT], [BTN.RIGHT], [BTN.RIGHT, BTN.DOWN],
                [BTN.DOWN], [BTN.DOWN, BTN.LEFT], [BTN.LEFT], [BTN.LEFT, BTN.UP]][pos];
  let m = 0;
  for (const b of dirs) m |= 1 << b;
  return m;
}

function padName(p) {
  const id = p.id.replace(/\(.*?\)/g, "").replace(/\s+/g, " ").trim();
  return id.length > 34 ? id.slice(0, 32) + "…" : id || "Controller";
}

// Every connected controller, in the order the browser numbers them.
function padWords() {
  const out = [];
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) {
    if (!p || !p.connected) continue;
    let w = 0, c = 0;
    p.buttons.forEach((b, i) => {
      const down = b.pressed || b.value > 0.5;
      if (!down) return;
      if (i in PAD_CYCLE) c |= 1 << PAD_CYCLE[i];
      else if (i in PAD_BTN) w |= 1 << PAD_BTN[i];
    });
    w |= stickBits(p.axes[0] || 0, p.axes[1] || 0);
    if (p.mapping !== "standard") w |= hatBits(p.axes[9]);
    const aim = settings.twinStick && p.axes.length >= 4 ? aimNibble(stickBits(p.axes[2] || 0, p.axes[3] || 0)) : 0;
    out.push({ w, c, aim, name: padName(p), index: p.index });
  }
  return out;
}
window.addEventListener("gamepadconnected", (e) => { toast(`Controller connected: ${padName(e.gamepad)}`); padsSeen = true; });
window.addEventListener("gamepaddisconnected", (e) => toast(`Controller disconnected: ${padName(e.gamepad)}`));
let padsSeen = false;

// The cycle bits are presses, not holds: a word carries one only on the frame
// the button went down.
const cyclePrev = [0, 0];
function edge(slot, held) { const e = held & ~cyclePrev[slot]; cyclePrev[slot] = held; return e; }

function word(src) {
  return (src.w & 0xfff) | ((src.aim || 0) << AIM_SHIFT);
}

// This browser's controllers as the two players' words. Offline the keyboard
// and the first pad are player 1 and the second pad is player 2; online
// everything here is the one local player.
//
// Offline: the first controller is player 1 and the second player 2, or the
// other way round with "Swap"; the keyboard joins whichever player the setting
// says. Online: everything on this computer is the one local player.
function assignment(pads) {
  const first = settings.padSwap ? 1 : 0;
  const slot = [[], []];
  if (pads[0]) slot[first].push(pads[0]);
  if (pads[1]) slot[1 - first].push(pads[1]);
  for (let i = 2; i < pads.length; i++) slot[0].push(pads[i]); // a third pad helps player 1
  return slot;
}

let lastSample = null;
function sampleLocal() {
  const kb = keyboardWord(), pads = padWords();
  const merge = (list, withKb) => {
    let w = withKb ? kb.w : 0, c = withKb ? kb.c : 0, aim = 0;
    for (const p of list) { w |= p.w; c |= p.c; aim = aim || p.aim; }
    return { w, c, aim };
  };
  let out;
  if (net.mode === "play") {
    const me = merge(pads, true);
    out = [word(me) | (edge(0, me.c) << CYCLE_SHIFT), 0];
    lastSample = { pads, words: [me.w | me.c, 0] };
  } else {
    const slot = assignment(pads);
    const kbTo = settings.kbPlayer === 2 ? 1 : 0;
    const a = merge(slot[0], kbTo === 0), b = merge(slot[1], kbTo === 1);
    out = [word(a) | (edge(0, a.c) << CYCLE_SHIFT), word(b) | (edge(1, b.c) << CYCLE_SHIFT)];
    lastSample = { pads, words: [a.w | a.c | a.aim, b.w | b.c | b.aim] };
  }
  return out;
}

// The Controllers panel: who is holding what, refreshed a few times a second.
let panelTick = 0;
function updatePadPanel() {
  if (++panelTick % 8) return;
  const pads = lastSample?.pads || padWords();
  const words = lastSample?.words || [0, 0];
  const online = net.mode === "play";
  const mine = net.role === "guest" ? 1 : 0;
  const labels = [[], []];
  if (online) {
    labels[mine] = ["Keyboard", ...pads.map((p) => p.name)];
    labels[1 - mine] = ["Your friend"];
  } else {
    const slot = assignment(pads);
    const kbTo = settings.kbPlayer === 2 ? 1 : 0;
    for (let i = 0; i < 2; i++) {
      labels[i] = slot[i].map((p) => p.name);
      if (kbTo === i) labels[i].unshift("Keyboard");
      if (!labels[i].length) labels[i] = [i === 1 ? "No controller yet" : "Nothing assigned"];
    }
  }
  for (let i = 0; i < 2; i++) {
    const text = labels[i].join(" + ");
    if ($("slot" + (i + 1) + "-dev").textContent !== text) $("slot" + (i + 1) + "-dev").textContent = text;
    const live = online ? (i === mine ? words[0] : 0) : words[i];
    $("slot" + (i + 1)).dataset.live = live ? "1" : "0";
    $("slot" + (i + 1)).dataset.empty = /^(No controller|Nothing)/.test(text) ? "1" : "0";
  }
  $("pad-hint").textContent = pads.length
    ? (online ? "Online, every controller on this computer plays as you." : pads.length === 1
        ? "Plug in a second controller for player 2, then press a button on it."
        : "Hold a button to see which player it controls.")
    : "Press any button on a controller to connect it. Browsers only show a controller once it's pressed.";
  $("btn-swap").disabled = online;
  $("set-kb").disabled = online;
}

// --- the machine ----------------------------------------------------------------------
async function boot(flags = flagsOf(settings), cheats = settings.cheats) {
  const m = await Machine.create(wasmModule);
  const r = m.init(rom, flags, cheats);
  if (r) {
    const why = { 2: "This file is not a SNES cartridge the core can load.",
                  3: "This cartridge is not the one the cheats know; turn them off or use the USA ROM." };
    throw new Error(why[r] || `The machine could not start (code ${r}).`);
  }
  machine = m;
  if (audio.node) audio.node.port.postMessage("flush");
  audio.queued = 0;
  return m;
}

// A ROM file, from the picker, a drop or the browser's saved copy. True if the
// game started with it.
async function loadRom(bytes, remember) {
  // Some cartridge readers and older copiers put a 512-byte header in front of
  // the image (.smc files); the game is what follows it.
  if (bytes.length % 1024 === 512) bytes = bytes.subarray(512);
  const sha = await sha1(bytes);
  // Joining someone needs the same file they have, so a wrong one is turned
  // away here, with a reason, rather than by the host a moment later.
  if (net.pendingJoin && sha && sha !== KNOWN_SHA1) {
    joinDropError("That file isn't the Zombies Ate My Neighbors (USA) ROM, so it can't join your friend's game. " +
                  "Check you picked the right file, and that the cartridge is the North American release.");
    return false;
  }
  rom = bytes;
  romCrc = crc32(bytes);
  $("rom-name").textContent = sha === KNOWN_SHA1
    ? "Zombies Ate My Neighbors (USA) · verified"
    : `Unrecognized ROM (SHA-1 ${sha ? sha.slice(0, 10) + "…" : "unknown"}). The USA release is the one supported.`;
  $("rom-name").dataset.ok = sha === KNOWN_SHA1 ? "1" : "0";
  if (remember) filePut("rom", bytes);
  try {
    await boot();
  } catch (err) {
    if (net.pendingJoin) joinDropError(err.message); else toast(err.message, 6000);
    return false;
  }
  closeJoinDrop();
  $("insert").hidden = true;
  $("screen-wrap").dataset.live = "1";
  document.body.dataset.rom = "1";
  if (net.pendingJoin) joinGame(net.pendingJoin);
  return true;
}

// The invite prompt: what someone arriving from an invite link sees first.
function openJoinDrop(code, haveSaved) {
  $("jd-code").textContent = code;
  $("jd-saved").hidden = !haveSaved;
  $("jd-choose").classList.toggle("primary", !haveSaved);
  $("jd-error").hidden = true;
  $("join-drop").hidden = false;
  (haveSaved ? $("jd-saved") : $("jd-choose")).focus();
}
function closeJoinDrop() { $("join-drop").hidden = true; }
function joinDropError(text) {
  $("jd-error").textContent = text;
  $("jd-error").hidden = false;
  $("join-drop").hidden = false;
}

async function romFromFile(f) {
  if (!f) return;
  await audioStart();
  loadRom(new Uint8Array(await f.arrayBuffer()), true);
}

async function sha1(bytes) {
  try {
    const h = await crypto.subtle.digest("SHA-1", bytes);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch { return null; }
}

let quickState = null;
async function quickSave() {
  if (!machine) return;
  if (net.mode !== "off") return toast("Quick save is off during online play.");
  for (let i = 0; i < 300 && !machine.canSave(); i++) machine.frame(0, 0);
  const s = machine.saveState();
  if (!s) return toast("Could not save just now. Try again.");
  quickState = s;
  filePut("quicksave:" + romCrc + ":" + buildId + ":" + flagsOf(settings) + ":" + settings.cheats, s);
  toast("Saved");
}
async function quickLoad() {
  if (!machine) return;
  if (net.mode !== "off") return toast("Quick load is off during online play.");
  const s = quickState || await fileGet("quicksave:" + romCrc + ":" + buildId + ":" + flagsOf(settings) + ":" + settings.cheats);
  if (!s) return toast("No quick save yet. Press F5 to make one.");
  toast(machine.loadState(s) === 0 ? "Loaded" : "That save is from other settings.");
}

function togglePause() {
  if (net.mode !== "off") return toast("Use Start to pause during online play.");
  paused = !paused;
  $("paused").hidden = !paused;
}

function toggleFullscreen() {
  const el = $("screen-wrap");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else el.requestFullscreen?.().catch(() => toast("Fullscreen is not available here."));
}

// --- online play -------------------------------------------------------------------------
const net = {
  mode: "off",         // off | hosting (waiting) | sync | play
  role: null,          // host | guest
  peer: null, conn: null,
  epoch: 0, delay: 3, base: 0, f: 0, sentUpTo: 0,
  local: new Map(), remote: new Map(),
  myHash: new Map(), theirHash: new Map(),
  rtt: 0, stallSince: 0, pendingJoin: null, wantSync: false,
  broker: PUBLIC_BROKER, startMsg: null, incoming: null, got: 0,
};
const STATE_CHUNK = 16384;

function setNetStatus(text, state) {
  $("net-status").textContent = text;
  $("net-status").dataset.state = state || "";
}

function randomId() {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}

function hostGame() {
  if (!machine) return toast("Load your ROM first.");
  if (net.peer) return;
  const code = randomId();
  setNetStatus("Opening a room…", "busy");
  net.peer = new Peer(ID_PREFIX + code, net.broker);
  net.role = "host";
  net.peer.on("open", () => {
    net.mode = "hosting";
    const link = location.origin + location.pathname + "?join=" + code;
    $("invite-link").value = link;
    $("invite-code").textContent = code;
    $("invite").hidden = false;
    setNetStatus("Room open. Send the link to a friend.", "wait");
    syncButtons();
  });
  net.peer.on("connection", (conn) => {
    if (net.conn) { conn.on("open", () => { conn.send({ t: "reject", why: "This room already has two players." }); setTimeout(() => conn.close(), 500); }); return; }
    attach(conn);
  });
  net.peer.on("error", (err) => { setNetStatus(peerError(err), "bad"); leave(false); });
}

function joinGame(code) {
  code = String(code).trim().toLowerCase().replace(/^.*join=/, "").replace(ID_PREFIX, "");
  if (!code) return;
  if (!machine) { net.pendingJoin = code; setNetStatus(`Load your ROM to join room ${code}.`, "wait"); return; }
  net.pendingJoin = null;
  if (net.peer) return;
  net.role = "guest";
  setNetStatus(`Connecting to room ${code}…`, "busy");
  net.peer = new Peer(ID_PREFIX + "g-" + randomId(), net.broker);
  net.peer.on("open", () => attach(net.peer.connect(ID_PREFIX + code)));
  net.peer.on("error", (err) => { setNetStatus(peerError(err), "bad"); leave(false); });
  syncButtons();
}

function peerError(err) {
  if (err?.type === "peer-unavailable") return "No room with that code. Check the link, or ask your friend to host again.";
  if (err?.type === "network" || err?.type === "server-error") return "Could not reach the connection broker. Check your internet connection.";
  if (err?.type === "unavailable-id") return "That room code is taken. Try hosting again.";
  return "Connection failed: " + (err?.message || err?.type || err);
}

function attach(conn) {
  net.conn = conn;
  conn.on("open", () => {
    if (net.role === "guest") conn.send({ t: "hello", proto: PROTO, rom: romCrc, build: buildId });
    else setNetStatus("A friend is connecting…", "busy");
  });
  conn.on("data", onData);
  conn.on("close", () => { if (net.conn === conn) { toast("Your partner left. The game carries on offline.", 4000); leave(true); } });
  conn.on("error", (e) => { console.warn("connection:", e); setNetStatus(e.message, "bad"); });
}

const pings = [];
function onData(m) {
  if (m instanceof ArrayBuffer) {
    // A piece of the host's save state, after its "start".
    if (!net.incoming) return;
    net.incoming.set(new Uint8Array(m), net.got);
    net.got += m.byteLength;
    if (net.got >= net.incoming.length) { const s = net.incoming; net.incoming = null; guestStart(net.startMsg, s); }
    return;
  }
  if (!m || typeof m !== "object") return;
  switch (m.t) {
    case "hello": // host
      if (m.proto !== PROTO || m.build !== buildId) return reject("Your friend is running a different version of the page. Both of you should reload it.");
      if (m.rom !== romCrc) return reject("Your ROMs are different files. Both players need the same USA ROM.");
      setNetStatus("Measuring the connection…", "busy");
      pings.length = 0;
      for (let i = 0; i < 6; i++) setTimeout(() => net.conn?.send({ t: "ping", s: performance.now() }), i * 120);
      break;
    case "ping": net.conn.send({ t: "pong", s: m.s }); break;
    case "pong":
      pings.push(performance.now() - m.s);
      if (pings.length === 6) {
        pings.sort((a, b) => a - b);
        net.rtt = pings[2];
        net.delay = Math.max(2, Math.min(10, Math.ceil(net.rtt / 2 / FRAME_MS) + 2));
        net.wantSync = true;
        net.mode = "sync";
      }
      break;
    case "reject": setNetStatus(m.why, "bad"); leave(false); break;
    case "start":
      net.mode = "sync";
      net.startMsg = m;
      net.incoming = new Uint8Array(m.stateLen);
      net.got = 0;
      setNetStatus("Receiving the game…", "busy");
      break;
    case "ready": if (m.e === net.epoch) beginLockstep(); break;
    case "in":
      if (m.e === net.epoch) for (let i = 0; i < m.v.length; i++) net.remote.set(m.f + i, m.v[i]);
      break;
    case "hash":
      if (m.e !== net.epoch) break;
      net.theirHash.set(m.f, m.h);
      checkHash(m.f);
      break;
    case "desync": if (net.role === "host") { net.wantSync = true; net.mode = "sync"; } break;
  }
}

function reject(why) {
  net.conn.send({ t: "reject", why });
  setNetStatus("A friend tried to join: " + why, "bad");
  const c = net.conn;
  net.conn = null;
  setTimeout(() => c.close(), 500);
}

// Host: stop at a tick that ends clean, and send the machine as it is.
function hostSync() {
  const s = machine.saveState();
  if (!s) { const [a, b] = sampleLocal(); machine.frame(a, b); audioFrame(); return; }
  net.wantSync = false;
  net.epoch++;
  net.conn.send({ t: "start", e: net.epoch, flags: machine.flags, cheats: machine.cheats,
                  delay: net.delay, rtt: net.rtt, stateLen: s.length });
  for (let at = 0; at < s.length; at += STATE_CHUNK) net.conn.send(s.subarray(at, at + STATE_CHUNK));
  setNetStatus("Sending the game to your friend…", "busy");
}

async function guestStart(m, state) {
  try {
    if (!machine || machine.flags !== m.flags || machine.cheats !== m.cheats) await boot(m.flags, m.cheats);
    const r = machine.loadState(state);
    if (r) throw new Error("The host's game could not be loaded (" + r + ").");
  } catch (err) {
    setNetStatus(err.message, "bad");
    return leave(false);
  }
  net.epoch = m.e;
  net.delay = m.delay;
  net.rtt = m.rtt;
  if (audio.node) audio.node.port.postMessage("flush");
  net.conn.send({ t: "ready", e: m.e });
  beginLockstep();
}

function beginLockstep() {
  net.base = net.f = machine.frameCount;
  net.local.clear(); net.remote.clear(); net.myHash.clear(); net.theirHash.clear();
  for (let k = net.base; k < net.base + net.delay; k++) { net.local.set(k, 0); net.remote.set(k, 0); }
  net.sentUpTo = net.base + net.delay - 1;
  net.mode = "play";
  paused = false;
  $("paused").hidden = true;
  $("invite").hidden = true;
  setNetStatus(`Playing online as player ${net.role === "host" ? 1 : 2}`, "good");
  syncButtons();
}

// One lockstep frame, if both players' words for it are here.
function netStep() {
  const target = net.f + net.delay;
  if (net.sentUpTo < target) {
    const first = net.sentUpTo + 1, v = [];
    while (net.sentUpTo < target) {
      net.sentUpTo++;
      const w = sampleLocal()[0];
      net.local.set(net.sentUpTo, w);
      v.push(w);
    }
    net.conn.send({ t: "in", e: net.epoch, f: first, v });
  }
  if (!net.remote.has(net.f)) return false;
  const mine = net.local.get(net.f), theirs = net.remote.get(net.f);
  if (net.role === "host") machine.frame(mine, theirs); else machine.frame(theirs, mine);
  net.local.delete(net.f - 60); net.remote.delete(net.f - 60);
  net.f++;
  if ((net.f - net.base) % HASH_EVERY === 0) {
    const h = machine.hash();
    net.myHash.set(net.f, h);
    net.conn.send({ t: "hash", e: net.epoch, f: net.f, h });
    checkHash(net.f);
  }
  return true;
}

function checkHash(f) {
  if (!net.myHash.has(f) || !net.theirHash.has(f)) return;
  const same = net.myHash.get(f) === net.theirHash.get(f);
  net.myHash.delete(f); net.theirHash.delete(f);
  net.checks = (net.checks || 0) + 1;
  if (same) return;
  net.desyncs = (net.desyncs || 0) + 1;
  console.warn("desync at frame", f);
  toast("Games drifted apart. Resyncing…");
  if (net.role === "host") { net.wantSync = true; net.mode = "sync"; }
  else net.conn.send({ t: "desync", e: net.epoch });
}

function leave(keepPlaying) {
  const c = net.conn, p = net.peer;
  net.conn = null; net.peer = null;
  net.mode = "off"; net.role = null;
  try { c?.close(); } catch {}
  try { p?.destroy(); } catch {}
  $("invite").hidden = true;
  $("waiting").hidden = true;
  if (keepPlaying) setNetStatus("Offline", "");
  syncButtons();
}

function syncButtons() {
  const online = net.mode !== "off" || net.peer;
  $("btn-host").hidden = !!online;
  $("join-form").hidden = !!online;
  $("btn-leave").hidden = !online;
  document.querySelectorAll("[data-setting]").forEach((el) => { el.disabled = net.role === "guest"; });
  $("net-meta").textContent = net.mode === "play"
    ? `Round trip ${Math.round(net.rtt)} ms · input delay ${net.delay} frames`
    : "";
}

// --- the loop -------------------------------------------------------------------------
let last = performance.now(), acc = 0;
function loop(now) {
  requestAnimationFrame(loop);
  let dt = now - last;
  last = now;
  if (dt > 250) dt = FRAME_MS;
  if (!machine || paused) { acc = 0; if (!machine) { lastSample = null; updatePadPanel(); } return; }
  if (net.mode === "hosting" && net.conn === null) {} // waiting for a friend: play on
  if (net.mode === "sync") {
    if (net.role === "host" && net.wantSync && net.conn) hostSync();
    acc = 0;
    draw();
    return;
  }
  acc += dt;
  let ran = 0;
  while (acc >= FRAME_MS && ran < 4) {
    if (net.mode === "play") {
      if (!netStep()) { acc = Math.min(acc, FRAME_MS); break; }
    } else {
      const [a, b] = sampleLocal();
      machine.frame(a, b);
    }
    audioFrame();
    acc -= FRAME_MS;
    ran++;
  }
  // Online, a side that has fallen behind its partner runs one extra frame to
  // catch up, rather than staying a frame of latency behind for good.
  if (net.mode === "play" && ran > 0 && net.remote.has(net.f + 2) && netStep()) audioFrame();
  if (net.mode === "play") {
    if (ran === 0) {
      net.stallSince ||= now;
      $("waiting").hidden = now - net.stallSince < 300;
    } else { net.stallSince = 0; $("waiting").hidden = true; }
  }
  if (ran) draw();
  updatePadPanel();
}

// --- page wiring ---------------------------------------------------------------------------
function bindSettings() {
  const boxes = { "set-skip": "skipIntro", "set-twin": "twinStick", "set-overlay": "effectOverlay",
                  "set-monsters": "allMonsterSounds", "set-radar": "steadyRadar", "set-blood": "redBlood" };
  for (const [id, key] of Object.entries(boxes)) {
    const el = $(id);
    el.checked = !!settings[key];
    el.addEventListener("change", () => { settings[key] = el.checked; store.set("settings", settings); needsRestart(); });
  }
  const list = $("cheat-list");
  CHEATS.forEach((name, i) => {
    const id = "cheat-" + i;
    const row = document.createElement("label");
    row.className = "check";
    row.innerHTML = `<input type="checkbox" id="${id}" data-setting><span>${name}</span>`;
    list.appendChild(row);
    const el = row.querySelector("input");
    el.checked = !!(settings.cheats & (1 << i));
    el.addEventListener("change", () => {
      settings.cheats = el.checked ? settings.cheats | (1 << i) : settings.cheats & ~(1 << i);
      store.set("settings", settings);
      needsRestart();
    });
  });
  const vol = $("set-volume");
  vol.value = settings.volume;
  vol.addEventListener("input", () => {
    settings.volume = +vol.value;
    store.set("settings", settings);
    if (audio.gain) audio.gain.gain.value = settings.volume / 100;
  });
  const kbSel = $("set-kb");
  kbSel.value = String(settings.kbPlayer === 2 ? 2 : 1);
  kbSel.addEventListener("change", () => { settings.kbPlayer = +kbSel.value; store.set("settings", settings); });
  $("btn-swap").addEventListener("click", () => {
    settings.padSwap = !settings.padSwap;
    store.set("settings", settings);
    toast(settings.padSwap ? "First controller is now player 2" : "First controller is now player 1");
  });
  const sharp = $("set-sharp");
  sharp.checked = settings.sharp;
  canvas.dataset.sharp = settings.sharp ? "1" : "0";
  sharp.addEventListener("change", () => {
    settings.sharp = sharp.checked; store.set("settings", settings);
    canvas.dataset.sharp = settings.sharp ? "1" : "0";
  });
}

function needsRestart() {
  if (!machine) return;
  $("restart-note").hidden = false;
}

async function main() {
  bindSettings();
  $("rom-file").addEventListener("change", (e) => { romFromFile(e.target.files[0]); e.target.value = ""; });
  $("jd-choose").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("jd-file").click(); }
  });
  $("jd-file").addEventListener("change", (e) => { romFromFile(e.target.files[0]); e.target.value = ""; });
  // A ROM can be dropped anywhere on the page. `depth` counts the enter/leave
  // pairs that children fire, so the highlight goes only when the drag leaves
  // the window.
  let depth = 0;
  const hasFile = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  window.addEventListener("dragenter", (e) => { if (hasFile(e)) { depth++; document.body.dataset.drag = "1"; } });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; delete document.body.dataset.drag; } });
  window.addEventListener("dragover", (e) => { if (hasFile(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!hasFile(e)) return;
    e.preventDefault();
    depth = 0; delete document.body.dataset.drag;
    romFromFile(e.dataTransfer.files[0]);
  });
  const useSaved = async () => {
    await audioStart();
    const saved = await fileGet("rom");
    if (saved) loadRom(new Uint8Array(saved), false);
    else joinDropError("There's no saved ROM in this browser any more. Choose the file instead.");
  };
  $("btn-resume").addEventListener("click", useSaved);
  $("jd-saved").addEventListener("click", useSaved);
  $("jd-dismiss").addEventListener("click", () => {
    closeJoinDrop();
    net.pendingJoin = null;
    setNetStatus("Offline", "");
  });
  // Browsers start sound only after a click or a key.
  const wake = () => { if (machine) audioStart(); };
  window.addEventListener("pointerdown", wake);
  window.addEventListener("keydown", wake);

  $("btn-restart").addEventListener("click", async () => {
    if (!rom || net.mode !== "off") return;
    await boot();
    $("restart-note").hidden = true;
    toast("Restarted with the new settings");
  });
  $("btn-fullscreen").addEventListener("click", toggleFullscreen);
  $("btn-save").addEventListener("click", quickSave);
  $("btn-load").addEventListener("click", quickLoad);
  $("btn-host").addEventListener("click", () => { audioStart(); try { hostGame(); } catch (e) { setNetStatus(e.message, "bad"); } });
  $("join-form").addEventListener("submit", (e) => {
    e.preventDefault();
    audioStart();
    try { joinGame($("join-code").value); } catch (err) { setNetStatus(err.message, "bad"); }
  });
  $("btn-leave").addEventListener("click", () => { leave(true); toast("Left the online game"); });
  $("btn-copy").addEventListener("click", async () => {
    const el = $("invite-link");
    try { await navigator.clipboard.writeText(el.value); toast("Link copied"); }
    catch { el.select(); toast("Press Ctrl+C to copy the link"); }
  });

  setNetStatus("Offline", "");
  syncButtons();

  const res = await fetch("zamn.wasm");
  if (!res.ok) throw new Error("zamn.wasm is missing next to this page.");
  const bytes = new Uint8Array(await res.arrayBuffer());
  buildId = crc32(bytes);
  wasmModule = await WebAssembly.compile(bytes);
  $("build-id").textContent = buildId.toString(16).padStart(8, "0");

  // The broker: this page's own server's, if it has one (server.mjs), or one
  // named in the address (?broker=wss://...), or the public PeerJS one.
  const params = new URLSearchParams(location.search);
  if (params.get("broker")) net.broker = params.get("broker");
  else {
    try {
      const b = await fetch("broker.json", { cache: "no-store" });
      if (b.ok) {
        const j = await b.json();
        net.broker = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + j.path;
      }
    } catch {}
  }
  const join = params.get("join");
  if (join) {
    net.pendingJoin = join.toLowerCase();
    $("join-code").value = net.pendingJoin;
    setNetStatus(`Load your ROM to join room ${net.pendingJoin}.`, "wait");
  }
  const haveSaved = !!(await fileGet("rom"));
  if (haveSaved) $("btn-resume").hidden = false;
  if (net.pendingJoin) openJoinDrop(net.pendingJoin, haveSaved);
  requestAnimationFrame(loop);
}

main().catch((err) => { console.error(err); toast(err.message, 10000); });

// For the browser console and the automated test: the live machine and session.
window.zamn = { net, get machine() { return machine; } };

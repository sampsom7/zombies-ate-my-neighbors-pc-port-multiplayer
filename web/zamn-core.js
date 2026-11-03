// The machine, as JavaScript sees it: one instance of zamn.wasm, which is one
// console. Works in a browser and in Node (web/test_wasm.mjs).
//
// zamn.wasm is a WASI "reactor" built by web/build.sh. It asks for seven WASI
// calls, all for stdio; they are answered here with the console.

const WASI_EBADF = 8;

function makeWasi(getMemory) {
  let line = "";
  const dec = new TextDecoder();
  return {
    fd_write(fd, iovs, iovsLen, nwrittenPtr) {
      const dv = new DataView(getMemory().buffer);
      let written = 0;
      for (let i = 0; i < iovsLen; i++) {
        const ptr = dv.getUint32(iovs + i * 8, true);
        const len = dv.getUint32(iovs + i * 8 + 4, true);
        line += dec.decode(new Uint8Array(getMemory().buffer, ptr, len));
        written += len;
      }
      let nl;
      while ((nl = line.indexOf("\n")) >= 0) {
        (fd === 2 ? console.warn : console.log)("[zamn] " + line.slice(0, nl));
        line = line.slice(nl + 1);
      }
      dv.setUint32(nwrittenPtr, written, true);
      return 0;
    },
    fd_close: () => 0,
    fd_seek: () => WASI_EBADF,
    fd_fdstat_get(fd, buf) {
      const dv = new DataView(getMemory().buffer);
      for (let i = 0; i < 24; i++) dv.setUint8(buf + i, 0);
      dv.setUint8(buf, 2); // character device
      dv.setBigUint64(buf + 8, 0xffffffffffffffffn, true);
      dv.setBigUint64(buf + 16, 0xffffffffffffffffn, true);
      return 0;
    },
    fd_prestat_get: () => WASI_EBADF,
    fd_prestat_dir_name: () => WASI_EBADF,
    proc_exit(code) { throw new Error("zamn.wasm exited with " + code); },
  };
}

// Settings, as `web_init` takes them (src/main_web.c).
export const FLAG = {
  SKIP_INTRO: 1, TWIN_STICK: 2, EFFECT_OVERLAY: 4, ALL_MONSTER_SOUNDS: 8,
  STEADY_RADAR: 16, RED_BLOOD: 32,
};
export const CHEATS = ["Invincible", "Invincible neighbors", "Infinite ammo",
                       "Infinite lives", "All weapons and items", "Always run"];

// SNES buttons, bit positions in the input word.
export const BTN = { B: 0, Y: 1, SELECT: 2, START: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7,
                     A: 8, X: 9, L: 10, R: 11 };
export const AIM_SHIFT = 12;  // up, down, left, right
export const CYCLE_SHIFT = 16; // next weapon, prev weapon, next item, prev item

export function crc32(bytes) {
  let crc = ~0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

export class Machine {
  static async create(wasmModule) {
    const m = new Machine();
    let memory = null;
    const inst = await WebAssembly.instantiate(wasmModule, {
      wasi_snapshot_preview1: makeWasi(() => memory),
    });
    m.x = inst.exports;
    memory = m.x.memory;
    m.x._initialize();
    return m;
  }

  get mem() { return this.x.memory.buffer; }

  // 0 on success; see `web_init` for the other codes.
  init(rom, flags, cheatMask) {
    const p = this.x.web_alloc(rom.length);
    new Uint8Array(this.mem, p, rom.length).set(rom);
    const r = this.x.web_init(p, rom.length, flags, cheatMask);
    this.flags = flags;
    this.cheats = cheatMask;
    return r;
  }

  frame(p1, p2) { this.x.web_frame(p1 >>> 0, p2 >>> 0); }
  get frameCount() { return this.x.web_frame_count() >>> 0; }

  // 256x224 RGBA, a view into the machine's memory (valid until the next call).
  pixels() { return new Uint8ClampedArray(this.mem, this.x.web_pixels(), 256 * 224 * 4); }

  // `count` stereo int16 pairs for the last tick, as a view.
  audio(count) {
    const n = this.x.web_audio(count);
    return new Int16Array(this.mem, this.x.web_audio_buffer(), n * 2);
  }

  canSave() { return this.x.web_can_save() !== 0; }

  // A copy of the machine's state, or null if it is not at rest this tick.
  saveState() {
    const n = this.x.web_save_state();
    if (!n) return null;
    return new Uint8Array(this.mem, this.x.web_state_buffer(), n).slice();
  }

  loadState(bytes) {
    const p = this.x.web_alloc(bytes.length);
    new Uint8Array(this.mem, p, bytes.length).set(bytes);
    const r = this.x.web_load_state(p, bytes.length);
    this.x.web_free(p);
    return r;
  }

  hash() { return this.x.web_hash() >>> 0; }
}

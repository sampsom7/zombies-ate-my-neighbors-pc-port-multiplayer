// Browser frontend: the same machine `main_sdl.c` drives, with JavaScript on
// the front instead of SDL.
//
// Built to WebAssembly (`web/build.sh`) as a WASI reactor with no `main`: the
// page calls `web_init` once with the cartridge, then `web_frame` once per
// tick with both controllers' state. JavaScript owns everything with a clock
// or a device behind it -- the canvas, Web Audio, the keyboard and gamepads,
// and the network -- and this file owns only the machine.
//
// That split is what makes netplay simple. The machine is deterministic: no
// clock, no random seed, nothing read that is not the cartridge or the two
// input words. Two browsers that start from the same state and are handed the
// same input words frame by frame compute the same frames, so a session only
// has to carry the inputs (lockstep), plus a save state once at the start so a
// player can join a game already under way. `web_hash` is how the two sides
// check they still agree.
//
// The input word, per player:
//   bits 0..11   SNES buttons, `BTN_*` order (B Y Select Start Up Down Left
//                Right A X L R)
//   bits 12..15  twin-stick aim: up, down, left, right (0 = not aiming)
//   bits 16..19  cycle requests: next weapon, previous weapon, next item,
//                previous item (edge-triggered; JS sends a press once)

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "snes.h"

#include "analysis/movie.h"
#include "cosim/cosim.h"
#include "port/player.h"
#include "port/oam.h"
#include "widescreen.h"
#include "twinstick.h"
#include "skipintro.h"
#include "maskline.h"
#include "cheats.h"
#include "bank_sfx.h"
#include "sound/console.h"
#include "sound/player.h"
#include "video/console.h"

// The boot's dark start, as `main_sdl.c` runs it (see `skip_intro` there).
#define INTRO_BYPASS_FIRST 30
#define INTRO_BYPASS_LIMIT 900
#define INTRO_BYPASS_LIGHT 222
#define INTRO_BYPASS_LEAD 8

#define WEB_EXPORT(name) __attribute__((export_name(#name)))

#define OUT_W 256
#define OUT_H 224
#define FB_W_MAX (VIDEO_MAX_WIDTH * 2)
#define FB_H 480
#define AUDIO_MAX 2048

// Settings, from `web_init`'s flags.
enum {
  WEB_SKIP_INTRO = 1 << 0,
  WEB_TWIN_STICK = 1 << 1,
  WEB_EFFECT_OVERLAY = 1 << 2,
  WEB_ALL_MONSTER_SOUNDS = 1 << 3,
  WEB_STEADY_RADAR = 1 << 4,
  WEB_RED_BLOOD = 1 << 5,
};

static Snes* snes;
static Cosim cosim;
static Widescreen ws;
static Sound sound;
static Player sound_lead;
static Player* follower;
static BankSfx bank;
static Cheats cheats;
static uint8_t* follower_state;
static bool twin_stick;
static uint32_t frame_count;
static uint32_t owners_serial;

static uint8_t fb[FB_W_MAX * FB_H * 4];
static uint8_t out_rgba[OUT_W * OUT_H * 4];
static int16_t audio_buf[AUDIO_MAX * 2];

static uint8_t* state_buf;
static int state_len;

WEB_EXPORT(web_alloc) void* web_alloc(int n) { return malloc((size_t)n); }
WEB_EXPORT(web_free) void web_free(void* p) { free(p); }

static void heard_tick(void) {
  if (!follower) return;
  player_run(follower, follower->lead->chip->host);
  bank_sfx_tick(&bank);
}

// The machine is set up exactly as `main_sdl.c` sets it up, in the same
// order, minus the window. Returns 0 on success, else a reason code.
// `cheat_mask` is a bit per `CheatId`.
WEB_EXPORT(web_init) int web_init(uint8_t* rom, int rom_len, int flags, int cheat_mask) {
  if (snes) return -1;
  snes = video_snes_init(VIDEO_NATIVE, false);
  if (!snes) return 1;
  if (!snes_loadRom(snes, rom, rom_len)) return 2;

  twin_stick = (flags & WEB_TWIN_STICK) && twin_install(snes->cart->rom, snes->cart->romSize);

  cheats_init(&cheats);
  for (int i = 0; i < CHEAT_COUNT; i++)
    if (cheat_mask & (1 << i)) cheats.on[i] = cheats.asked[i] = true;
  if (!cheats_install(&cheats, snes->cart->rom, (size_t)snes->cart->romSize)) return 3;

  cosim_init(&cosim, snes, COSIM_NATIVE);
  cosim_enable_all(&cosim);
  actor_overlap_reach = OVERLAP_REACH_STOCK;

  VideoChip* chip = video_chip_of(snes);
  video_set_pixel_format(chip, VIDEO_PIXELS_XRGB);
  video_set_margins(chip, 0, 0);

  widescreen_install(snes, &ws, rom, rom_len, 0);
  cosim_watch(&cosim, WS_PASS_DONE_AT, widescreen_pass_done, &ws);
  cosim_watch(&cosim, WS_OAM_SENT_AT, widescreen_oam_sent, &ws);
  ws.radar.steady = (flags & WEB_STEADY_RADAR) != 0;
  maskline_fix(snes->cart);
  if ((flags & WEB_RED_BLOOD) && blood_patch_rom(snes->cart->rom, (size_t)snes->cart->romSize))
    ws.blood.on = true;

  sound_attach(snes, &sound, &sound_lead);
  snes_reset(snes, true);

  const bool overlay = (flags & WEB_EFFECT_OVERLAY) != 0;
  const bool monsters = (flags & WEB_ALL_MONSTER_SOUNDS) != 0;
  if (overlay || monsters) {
    follower = (Player*)malloc(sizeof *follower);
    if (follower) {
      PlayerSettings ps = overlay ? player_wide : player_console;
      ps.other_sets = monsters;
      player_init(follower, ps);
      player_follow(follower, &sound_lead);
    }
  }
  sound_lead.silent = follower != NULL;
  follower_state = (uint8_t*)calloc(1, player_state_max);
  bank_sfx_init(&bank, follower, snes->cart->rom, (int)snes->cart->romSize, monsters);
  if (bank.enabled) {
    bool watched = true;
    for (int k = 0; k < bank.sites && watched; k++)
      watched = cosim_watch(&cosim, bank.site_at[k], bank_sfx_at, &bank);
    if (!watched) bank.enabled = false;
  }

  // The dark start of the boot, at full speed, as the desktop build does it:
  // to the title with the logos bypassed, or to the Konami logo without.
  const bool bypass = (flags & WEB_SKIP_INTRO) && intro_bypass(snes->cart);
  const long last = bypass ? INTRO_BYPASS_LIGHT - INTRO_BYPASS_LEAD : INTRO_BYPASS_LIMIT;
  for (long f = 0; f < last; f++) {
    if (f >= INTRO_BYPASS_FIRST && !chip->registers.blank) break;
    cosim_frame(&cosim);
    heard_tick();
  }
  owners_serial = sprite_oam_owners.serial;
  frame_count = 0;
  return 0;
}

static void apply_input(int port, uint32_t in) {
  uint16_t held = (uint16_t)(in & 0x0fffu);
  if (twin_stick) {
    // The aim nibble, put back where `pad_aim` would have put it: the D-pad
    // bits of a 12-bit mask.
    const uint16_t a = (uint16_t)((in >> 12) & 0xfu);
    const uint16_t stick = (uint16_t)(((a & 1u) << BTN_UP) | (((a >> 1) & 1u) << BTN_DOWN) |
                                      (((a >> 2) & 1u) << BTN_LEFT) | (((a >> 3) & 1u) << BTN_RIGHT));
    held |= twin_apply(snes->cart->rom, port, stick);
    player_set_aim((uint16_t)(port * 2), twin_aim_of(snes->cart->rom, port));
  }
  const uint32_t cyc = (in >> 16) & 0xfu;
  for (int c = 0; c < 4; c++)
    if (cyc & (1u << c))
      player_cycle_request((uint16_t)(port * 2), c >> 1 ? PSN_CYCLE_ITEM : PSN_CYCLE_WEAPON,
                           c & 1 ? -1 : +1);
  for (int b = 0; b < 12; b++) snes_setButtonState(snes, port + 1, b, (held >> b) & 1);
}

// One tick of the game with both controllers' words.
WEB_EXPORT(web_frame) void web_frame(uint32_t p1, uint32_t p2) {
  player_cycle_age();
  apply_input(0, p1);
  apply_input(1, p2);
  cheats_tick(&cheats, snes->ram, snes->cart->rom);
  cosim_frame(&cosim);
  heard_tick();
  owners_serial = sprite_oam_owners.serial;
  frame_count++;
}

WEB_EXPORT(web_frame_count) uint32_t web_frame_count(void) { return frame_count; }

// The last tick's picture as 256x224 RGBA: every other column and every
// other row of the core's 512x480 buffer, whose rows 16..463 are the picture
// with each line twice and each pixel twice.
WEB_EXPORT(web_pixels) uint8_t* web_pixels(void) {
  video_put_pixels(video_chip_of(snes), fb);
  const int w = video_output_width(video_chip_of(snes));
  for (int y = 0; y < OUT_H; y++) {
    const uint8_t* src = fb + (size_t)(16 + y * 2) * w * 4;
    uint8_t* dst = out_rgba + (size_t)y * OUT_W * 4;
    for (int x = 0; x < OUT_W; x++) {
      const uint8_t* s = src + x * 8;  // [B,G,R,X]
      dst[x * 4 + 0] = s[2];
      dst[x * 4 + 1] = s[1];
      dst[x * 4 + 2] = s[0];
      dst[x * 4 + 3] = 255;
    }
  }
  return out_rgba;
}

// `count` stereo pairs of this tick's sound (the core resamples its 534 a
// tick to whatever is asked, so the count is the rate control), at
// `web_audio_buffer`.
WEB_EXPORT(web_audio) int web_audio(int count) {
  if (count > AUDIO_MAX) count = AUDIO_MAX;
  if (count < 1) count = 1;
  snes_setSamples(snes, audio_buf, count);
  if (follower) player_get_samples(follower, audio_buf, count);
  return count;
}
WEB_EXPORT(web_audio_buffer) int16_t* web_audio_buffer(void) { return audio_buf; }

// The parts of the machine that live outside the core, as the quick save
// keeps them.
typedef struct { void* data; size_t size; } QuickPartWebT;

static uint8_t owners_fresh_byte;
static int collect_parts(QuickPartWebT* p) {
  int n = 0;
#define PART(ptr, sz) do { p[n].data = (void*)(ptr); p[n].size = (sz); n++; } while (0)
  PART(ws.mem, sizeof ws.mem);
  PART(&ws.have_mem, sizeof ws.have_mem);
  PART(ws.lent_frame, sizeof ws.lent_frame);
  PART(ws.lent_slot, sizeof ws.lent_slot);
  PART(&ws.lent_count, sizeof ws.lent_count);
  PART(ws.back_slot, sizeof ws.back_slot);
  PART(&ws.back_count, sizeof ws.back_count);
  PART(ws.slot_drawn, sizeof ws.slot_drawn);
  PART(&sprite_oam_owners, sizeof sprite_oam_owners);
  PART(sprite_oam_history, sizeof sprite_oam_history);
  PART(&owners_fresh_byte, sizeof owners_fresh_byte);
  PART(&frame_count, sizeof frame_count);
  PART(follower_state, follower_state ? player_state_max : 0);
#undef PART
  return n;
}

// Whether a save state can be taken now: not while the harness is part way
// through a routine of its own. Nearly every tick ends clean.
WEB_EXPORT(web_can_save) int web_can_save(void) { return cosim_idle(&cosim) ? 1 : 0; }

// A save state, at `web_state_buffer`, `web_state_len` bytes long. Returns
// its length, or 0 if the machine is not at rest.
WEB_EXPORT(web_save_state) int web_save_state(void) {
  if (!cosim_idle(&cosim)) return 0;
  if (follower_state) {
    memset(follower_state, 0, player_state_max);
    if (follower) player_save(follower, follower_state);
  }
  QuickPartWebT parts[16];
  const int count = collect_parts(parts);
  size_t extra = 0;
  for (int i = 0; i < count; i++) extra += parts[i].size;
  const int core = snes_saveState(snes, NULL);
  const int total = 8 + core + (int)extra;
  free(state_buf);
  state_buf = (uint8_t*)malloc((size_t)total);
  if (!state_buf) return 0;
  const uint32_t magic = 0x3153575au;  // 'ZWS1'
  memcpy(state_buf, &magic, 4);
  memcpy(state_buf + 4, &core, 4);
  snes_saveState(snes, state_buf + 8);
  uint8_t* at = state_buf + 8 + core;
  for (int i = 0; i < count; i++) {
    if (parts[i].size) memcpy(at, parts[i].data, parts[i].size);
    at += parts[i].size;
  }
  state_len = total;
  return total;
}
WEB_EXPORT(web_state_buffer) uint8_t* web_state_buffer(void) { return state_buf; }

// Load a state from `data` (a buffer from `web_alloc`). 0 on success.
WEB_EXPORT(web_load_state) int web_load_state(uint8_t* data, int len) {
  uint32_t magic;
  int core;
  if (len < 8) return 1;
  memcpy(&magic, data, 4);
  memcpy(&core, data + 4, 4);
  if (magic != 0x3153575au || core != snes_saveState(snes, NULL)) return 2;
  QuickPartWebT parts[16];
  const int count = collect_parts(parts);
  size_t extra = 0;
  for (int i = 0; i < count; i++) extra += parts[i].size;
  if ((size_t)len != 8 + (size_t)core + extra) return 3;
  if (!snes_loadState(snes, data + 8, core)) return 4;
  const uint8_t* at = data + 8 + core;
  for (int i = 0; i < count; i++) {
    if (parts[i].size) memcpy(parts[i].data, at, parts[i].size);
    at += parts[i].size;
  }
  cosim_forget_calls(&cosim);
  if (follower && !(follower_state && player_load(follower, follower_state, player_state_max)))
    player_resync(follower);
  widescreen_forget_passes(&ws);
  owners_serial = sprite_oam_owners.serial;
  cheats_loaded(&cheats);
  return 0;
}

// FNV-1a over work RAM: both sides of a netplay session compare this to know
// they are still running the same game.
WEB_EXPORT(web_hash) uint32_t web_hash(void) {
  uint32_t h = 2166136261u;
  for (int i = 0; i < 0x20000; i++) {
    h ^= snes->ram[i];
    h *= 16777619u;
  }
  return h;
}

// What the cartridge is, for the two sides to agree on before they play.
WEB_EXPORT(web_rom_crc) uint32_t web_rom_crc(uint8_t* rom, int len) {
  uint32_t crc = 0xffffffffu;
  for (int i = 0; i < len; i++) {
    crc ^= rom[i];
    for (int k = 0; k < 8; k++) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}

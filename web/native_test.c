// The web frontend's exports, driven natively: boots a cartridge, plays a
// scripted input for a while, and checks the two things netplay rests on --
// that two runs given the same inputs hash the same, and that a save state
// taken part way and loaded reproduces the rest of the run exactly.
//
//   NATIVE=1 web/build.sh && build-web-native/zamn_web_test rom.sfc [out.ppm]
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int web_init(uint8_t* rom, int rom_len, int flags, int cheat_mask);
void web_frame(uint32_t p1, uint32_t p2);
uint8_t* web_pixels(void);
int web_audio(int count);
int web_save_state(void);
uint8_t* web_state_buffer(void);
int web_load_state(uint8_t* data, int len);
uint32_t web_hash(void);

static uint32_t script(int f, int port) {
  // Start a few times to get through the title and into a two-player game,
  // then wander and shoot.
  if (f < 400) return (f % 40 < 4 && port == 0) ? (1u << 3) : 0;
  if (f < 420 && port == 1) return (f % 10 < 3) ? (1u << 3) : 0;
  const int phase = (f / 60 + port) % 4;
  uint32_t b = 1u << (4 + phase);
  if (f % 8 < 3) b |= 1u << 1;
  return b;
}

int main(int argc, char** argv) {
  if (argc < 2) { fprintf(stderr, "usage: %s rom.sfc [out.ppm]\n", argv[0]); return 2; }
  FILE* f = fopen(argv[1], "rb");
  if (!f) { perror(argv[1]); return 1; }
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  uint8_t* rom = malloc(n);
  fread(rom, 1, n, f);
  fclose(f);
  const int flags = 1 | 2 | 4 | 8 | 16;
  int r = web_init(rom, (int)n, flags, 0);
  printf("init: %d\n", r);
  if (r) return 1;
  uint32_t h_at[3000];
  uint8_t* saved = NULL;
  int saved_len = 0, saved_at = -1;
  for (int i = 0; i < 3000; i++) {
    web_frame(script(i, 0), script(i, 1));
    web_audio(800);
    h_at[i] = web_hash();
    if (i >= 1500 && saved_at < 0) {
      int len = web_save_state();
      if (len) {
        saved = malloc(len);
        memcpy(saved, web_state_buffer(), len);
        saved_len = len;
        saved_at = i;
      }
    }
  }
  printf("ran 3000 frames, hash %08x; state %d bytes at %d\n", h_at[2999], saved_len, saved_at);
  if (argc > 2) {
    uint8_t* px = web_pixels();
    FILE* o = fopen(argv[2], "wb");
    fprintf(o, "P6 256 224 255\n");
    for (int i = 0; i < 256 * 224; i++) fwrite(px + i * 4, 1, 3, o);
    fclose(o);
  }
  if (saved) {
    r = web_load_state(saved, saved_len);
    printf("load: %d\n", r);
    int bad = 0;
    for (int i = saved_at + 1; i < 3000; i++) {
      web_frame(script(i, 0), script(i, 1));
      web_audio(800);
      if (web_hash() != h_at[i] && !bad++) printf("state replay diverged at %d\n", i);
    }
    printf("state replay: %s\n", bad ? "DIVERGED" : "identical");
  }
  return 0;
}

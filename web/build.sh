#!/usr/bin/env bash
# Builds the browser version: web/zamn.wasm, beside web/index.html.
#
# Needs clang with the wasm32 target, wasm-ld, and a WASI sysroot (libc for
# WebAssembly). Any of these works:
#   * wasi-sdk (https://github.com/WebAssembly/wasi-sdk/releases): set
#     WASI_SDK=/path/to/wasi-sdk and its own clang is used.
#   * a system clang + lld, with WASI_SYSROOT pointing at wasi-sysroot-*/ and
#     WASI_RT at the libclang_rt.builtins-wasm32-wasi-*/ folder from the same
#     release page.
#
#   web/build.sh            # optimised build
#   NATIVE=1 web/build.sh   # the same sources as a native test program (gcc)
set -euo pipefail
cd "$(dirname "$0")/.."

SRC=(
  $(ls third_party/lakesnes/snes/*.c | grep -v -e '/ppu\.c$' -e '/snes_ppu\.c$')
  src/video/video.c src/video/registers.c src/video/frame.c src/video/chip.c
  src/video/state.c src/video/console.c src/video/without_ppu.c
  src/analysis/w65816.c src/analysis/cdl.c src/analysis/movie.c
  src/assets/lzss.c src/assets/gfx.c src/assets/rom.c src/assets/level.c
  src/assets/actor.c src/assets/sprite.c src/assets/music.c src/assets/password.c
  src/port/*.c
  src/cosim/cosim.c src/cosim/profile.c src/cosim/routines.c
  src/sound/dsp.c src/sound/sound.c src/sound/player.c src/sound/console.c
  src/main_web.c
)
INC=(-Isrc -Ithird_party/lakesnes/snes -DPORT_COVERAGE=1)

if [[ "${NATIVE:-0}" == 1 ]]; then
  mkdir -p build-web-native
  gcc -std=c11 -O2 -g "${INC[@]}" -DWEB_NATIVE_TEST "${SRC[@]}" web/native_test.c \
      -lm -o build-web-native/zamn_web_test
  echo "built build-web-native/zamn_web_test"
  exit 0
fi

if [[ -n "${WASI_SDK:-}" ]]; then
  CC="$WASI_SDK/bin/clang"
  SYSROOT="$WASI_SDK/share/wasi-sysroot"
  RTFLAGS=()
else
  CC="${CC:-clang}"
  SYSROOT="${WASI_SYSROOT:?set WASI_SYSROOT (or WASI_SDK)}"
  # clang looks for the wasm builtins under its own resource directory, which
  # a system clang ships without; a copy of it with them added is used instead.
  RT="${WASI_RT:?set WASI_RT to the libclang_rt.builtins-wasm32-wasi folder}"
  RES=build-web/clang-resource
  if [[ ! -f "$RES/lib/wasi/libclang_rt.builtins-wasm32.a" ]]; then
    mkdir -p "$RES/lib/wasi"
    cp -r "$("$CC" -print-resource-dir)/include" "$RES/"
    cp "$(ls "$RT"/*.a "$RT"/lib/*/*.a 2>/dev/null | head -1)" "$RES/lib/wasi/libclang_rt.builtins-wasm32.a"
  fi
  RTFLAGS=(-resource-dir "$RES")
fi

OBJ=build-web/obj
mkdir -p "$OBJ"
CFLAGS=(--target=wasm32-wasi --sysroot="$SYSROOT" -std=c11 -O2 "${INC[@]}"
        -D_WASI_EMULATED_SIGNAL -Wno-everything)

# Compiled in parallel; the objects are kept so a rebuild only redoes what changed.
pids=()
objs=()
for f in "${SRC[@]}"; do
  o="$OBJ/$(echo "$f" | tr '/' '_').o"
  objs+=("$o")
  if [[ ! -f "$o" || "$f" -nt "$o" ]]; then
    "$CC" "${CFLAGS[@]}" "${RTFLAGS[@]}" -c "$f" -o "$o" &
    pids+=($!)
    if (( ${#pids[@]} >= $(nproc) )); then wait "${pids[0]}"; pids=("${pids[@]:1}"); fi
  fi
done
for p in "${pids[@]}"; do wait "$p"; done

"$CC" --target=wasm32-wasi --sysroot="$SYSROOT" "${RTFLAGS[@]}" -O2 \
    -mexec-model=reactor -Wl,--export=malloc -Wl,--export=free \
    -Wl,-z,stack-size=1048576 -Wl,--initial-memory=67108864 -Wl,--max-memory=268435456 \
    -Wl,--strip-all -lwasi-emulated-signal \
    "${objs[@]}" -o web/zamn.wasm
ls -la web/zamn.wasm

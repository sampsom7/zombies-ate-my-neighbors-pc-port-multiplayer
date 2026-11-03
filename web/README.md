# Browser version (WebAssembly)

The same game as `zamn.exe`, running in a web page: the port's C code compiled
to WebAssembly (`zamn.wasm`) with a small JavaScript shell for the picture,
sound, controls and online play. Each player loads their own ROM; none is
included or uploaded anywhere.

## Play on your own computer

The page has to be served over HTTP (browsers will not load WebAssembly from a
`file://` page). With Node 18 or later installed:

```
node web/server.mjs
```

Then open <http://localhost:8080/>, click **Load ROM** and pick your USA `.sfc`.
The ROM is remembered in that browser for next time.

Two players on one computer: the keyboard and the first controller are player
1, and a second controller is player 2.

## Play online with a friend

1. Put the `web` folder on any static web host. These are free and need no
   setup beyond uploading the folder:
   - **Netlify Drop**: drag the `web` folder onto <https://app.netlify.com/drop>.
   - **itch.io**: zip the *contents* of `web`, create an HTML project, upload the
     zip, tick "This file will be played in the browser".
   - **GitHub Pages**: push the contents of `web` to a branch and turn Pages on
     for it.
2. Open your page, load your ROM, and click **Host a game**.
3. Send your friend the invite link. They open it, load their own copy of the
   ROM, and are dropped straight into your game as player 2, even mid-level.

How it works: the game is deterministic, so the two browsers send each other
only controller input (lockstep), and each runs a frame once it has both
players' input for it. Input is scheduled a few frames ahead, chosen from the
measured ping, to hide latency. When the guest joins, the host sends a save
state, so both start from the same moment. Every two seconds the two sides
compare a hash of the game's memory; if they ever disagree, the host resends
its state.

Players are introduced through the free public PeerJS broker
(`0.peerjs.com`); after that the game flows directly between the two browsers
over WebRTC. If the page is served by `server.mjs`, that server is the broker
instead, which suits a LAN party or your own server (open its port, and use
HTTPS in front of it for play across the internet). `?broker=wss://host/peerjs`
in the address overrides it.

Some strict networks (certain corporate or mobile carrier NATs) block direct
connections. The page then falls back to PeerJS's public relay servers, and if
those are unreachable the connection fails with a message saying so.

Quick save/load and pause are offline only; online, Start pauses the game for
both players as usual. The host's settings and cheats apply to both players.

## Building zamn.wasm

A prebuilt `zamn.wasm` is in this folder. To rebuild it after changing the C
code you need clang with the wasm32 target, `wasm-ld`, and a WASI sysroot,
all of which come in [wasi-sdk](https://github.com/WebAssembly/wasi-sdk/releases):

```
WASI_SDK=/path/to/wasi-sdk web/build.sh
```

(or, with a system clang + lld: `WASI_SYSROOT=.../wasi-sysroot-25.0
WASI_RT=.../libclang_rt.builtins-wasm32-wasi-25.0 web/build.sh`). On Windows,
run it from WSL or Git Bash.

The machine's browser-facing API is `src/main_web.c`. Checks:

```
NATIVE=1 web/build.sh && build-web-native/zamn_web_test rom.sfc   # native: save-state replay is exact
node web/test_wasm.mjs rom.sfc                                      # wasm matches native; a late joiner stays in sync
```

## Files

| File | What it is |
| --- | --- |
| `index.html`, `app.js` | the page: picture, sound, controls, settings, the netplay session |
| `zamn-core.js` | loads `zamn.wasm` and wraps its exports |
| `net.js` | WebRTC links and PeerJS-protocol signaling, with no library |
| `server.mjs` | static server + signaling broker, no dependencies |
| `zamn.wasm` | the game, built from `src/` by `build.sh` |

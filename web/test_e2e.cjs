// Two browsers, one game: host loads the ROM and plays a bit alone, opens a
// room; guest opens the invite link, loads the ROM, and joins mid-game. Then
// both drive their own player and the two machines must stay identical.
const { chromium } = require("playwright");
const ROM = process.argv[2] || "rom.sfc";  // node web/test_e2e.cjs rom.sfc, with web/server.mjs running
const BASE = "http://localhost:8080/";
const shot = (p, n) => p.screenshot({ path: `./${n}.png` });

(async () => {
  const b1 = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const b2 = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const host = await (await b1.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  const guest = await (await b2.newContext({ viewport: { width: 1280, height: 860 } })).newPage();
  for (const [p, n] of [[host, "host"], [guest, "guest"]]) {
    p.on("console", (m) => { if (m.type() !== "log" || !m.text().startsWith("[zamn]")) console.log(`${n} console:`, m.text()); });
    p.on("pageerror", (e) => console.log(`${n} pageerror:`, e.message));
  }
  await host.goto(BASE);
  await shot(host, "01-start");
  await host.setInputFiles("#rom-file", ROM);
  await host.waitForFunction(() => window.zamn?.machine?.frameCount > 0);
  // Through the title into a game: Start a few times.
  for (let i = 0; i < 8; i++) { await host.keyboard.press("Enter"); await host.waitForTimeout(700); }
  await host.waitForTimeout(1500);
  await shot(host, "02-host-solo");
  await host.click("#btn-host");
  await host.waitForSelector("#invite:not([hidden])");
  const link = await host.inputValue("#invite-link");
  console.log("invite:", link);
  await guest.goto(link);
  await guest.setInputFiles("#rom-file", ROM);
  await guest.waitForFunction(() => window.zamn.net.mode === "play", null, { timeout: 30000 });
  await host.waitForFunction(() => window.zamn.net.mode === "play");
  console.log("host:", await host.textContent("#net-status"), "|", await host.textContent("#net-meta"));
  console.log("guest:", await guest.textContent("#net-status"));
  // Guest presses Start to join in as player 2, then both move about.
  await host.keyboard.press("Enter"); await guest.keyboard.press("Enter");
  await host.waitForTimeout(800);
  await host.keyboard.press("Enter"); await guest.keyboard.press("Enter");
  await host.waitForTimeout(7000);
  const t0 = Date.now();
  const hf0 = await host.evaluate(() => window.zamn.net.f);
  for (let i = 0; i < 16; i++) {
    await host.keyboard.down(i % 2 ? "ArrowLeft" : "ArrowDown");
    await guest.keyboard.down(i % 2 ? "ArrowUp" : "ArrowRight");
    await host.keyboard.down("KeyA");
    await host.waitForTimeout(500);
    await host.keyboard.up("KeyA");
    await host.keyboard.up(i % 2 ? "ArrowLeft" : "ArrowDown");
    await guest.keyboard.up(i % 2 ? "ArrowUp" : "ArrowRight");
  }
  const hf1 = await host.evaluate(() => window.zamn.net.f);
  console.log(`host ran ${hf1 - hf0} frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await shot(host, "03-host-online");
  await shot(guest, "04-guest-online");
  await host.waitForTimeout(3000);
  for (const [p, n] of [[host, "host"], [guest, "guest"]])
    console.log(n, await p.evaluate(() => ({ f: window.zamn.net.f, checks: window.zamn.net.checks, desyncs: window.zamn.net.desyncs || 0 })));
  // Guest leaves; host carries on alone.
  await guest.click("#btn-leave");
  await host.waitForFunction(() => window.zamn.net.mode === "off", null, { timeout: 15000 });
  const f2 = await host.evaluate(() => window.zamn.machine.frameCount);
  await host.waitForTimeout(500);
  const f3 = await host.evaluate(() => window.zamn.machine.frameCount);
  console.log(`after guest left, host status "${await host.textContent("#net-status")}", still running: ${f3 > f2}`);
  await b1.close(); await b2.close();
})().catch((e) => { console.error(e); process.exit(1); });

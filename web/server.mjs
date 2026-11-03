// Serves the browser version and brokers its online games, on one port, with
// nothing but Node (18 or later) -- no packages to install.
//
//   node web/server.mjs            # http://localhost:8080
//   node web/server.mjs 3000
//
// The page works from any static host too (GitHub Pages, itch.io, Netlify);
// there it introduces players through the public PeerJS broker. Served from
// here, it uses this server's own broker instead (`broker.json` tells it so),
// which is useful on a LAN or a server of your own.
//
// The broker is the PeerJS server protocol's small core: a WebSocket per
// player at /peerjs?id=..., and OFFER / ANSWER / CANDIDATE / LEAVE relayed by
// `dst`. It never sees the game, only the introductions.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, join, normalize, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2] || process.env.PORT || 8080);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
                ".wasm": "application/wasm", ".json": "application/json", ".css": "text/css",
                ".png": "image/png", ".txt": "text/plain" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/broker.json") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify({ path: "/peerjs" }));
  }
  let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (path === "" || path.endsWith("/")) path += "index.html";
  if (path.includes("..") || path.endsWith(".mjs") || path.endsWith(".cjs") || path.endsWith(".c") || path.endsWith(".sh")) {
    res.writeHead(404); return res.end();
  }
  try {
    const body = await readFile(join(root, path));
    res.writeHead(200, { "content-type": TYPES[extname(path)] || "application/octet-stream", "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
});

// --- a minimal WebSocket (RFC 6455), text frames only --------------------------------
const clients = new Map(); // id -> socket

function wsSend(sock, obj) {
  if (sock.destroyed) return;
  const data = Buffer.from(JSON.stringify(obj));
  let head;
  if (data.length < 126) head = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  sock.write(Buffer.concat([head, data]));
}

function onMessage(id, text) {
  let m;
  try { m = JSON.parse(text); } catch { return; }
  if (m.type === "HEARTBEAT" || !m.dst) return;
  const to = clients.get(m.dst);
  if (to) wsSend(to, { type: m.type, src: id, payload: m.payload });
  else if (m.type === "OFFER") {
    const from = clients.get(id);
    setTimeout(() => from && wsSend(from, { type: "EXPIRE", src: m.dst }), 1500);
  }
}

server.on("upgrade", (req, sock) => {
  const url = new URL(req.url, "http://x");
  const id = url.searchParams.get("id");
  const key = req.headers["sec-websocket-key"];
  if (url.pathname !== "/peerjs" || !id || !key) { sock.destroy(); return; }
  const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
  sock.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
             `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  if (clients.has(id)) { wsSend(sock, { type: "ID-TAKEN", payload: { msg: "ID is taken" } }); sock.end(); return; }
  clients.set(id, sock);
  wsSend(sock, { type: "OPEN" });

  let buf = Buffer.alloc(0), parts = [];
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      const maskAt = at;
      if (masked) at += 4;
      if (buf.length < at + len) return;
      const payload = Buffer.from(buf.subarray(at, at + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i & 3)];
      buf = buf.subarray(at + len);
      if (op === 0x8) { sock.end(); return; }
      if (op === 0x9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
      if (op === 0x1 || op === 0x0) {
        parts.push(payload);
        if (fin) { onMessage(id, Buffer.concat(parts).toString("utf8")); parts = []; }
      }
    }
  });
  const gone = () => { if (clients.get(id) === sock) clients.delete(id); };
  sock.on("close", gone);
  sock.on("error", gone);
});

server.listen(port, () => {
  console.log(`Zombies Ate My Neighbors: http://localhost:${port}/`);
  console.log("Online games started here are brokered by this server.");
});

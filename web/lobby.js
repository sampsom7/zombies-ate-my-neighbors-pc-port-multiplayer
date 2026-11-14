// The lobby: a live list of open games that everyone on the site can see.
//
// There is no server of our own to keep that list (the page is static, and the
// broker only introduces browsers), so one of the players' browsers keeps it.
// Every page tries to take a well-known name on the broker, LOBBY_ID. The
// broker gives a name to one connection only, so exactly one page succeeds and
// becomes the keeper; every other page is told the name is taken, and connects
// to the keeper instead, as a member. Members tell the keeper about the room
// they are hosting, if any, and the keeper sends the whole list to everyone
// whenever it changes. When the keeper's page closes, its name is freed and
// its members' links drop; each of them waits a moment (a random one, so they
// do not all collide) and tries to take the name again, and one of them
// becomes the new keeper. Rooms are announced again to whoever that is.
//
// The list carries only what a row in the lobby shows: a room code to join,
// a name, whether it is waiting or playing, and which build of the game it
// runs. Joining a room is the ordinary invite path in app.js.

import { Peer } from "./net.js";

const LOBBY_ID = "zamn-nbr-lobby-v1";
const MEMBER_PREFIX = "zamn-nbr-m-";
const MAX_ROOMS = 200;

function randomId(n = 8) {
  return Math.random().toString(36).slice(2, 2 + n).padEnd(n, "0");
}

function clean(room) {
  if (!room || typeof room !== "object") return null;
  const code = String(room.code || "");
  if (!/^[a-z0-9]{4,12}$/.test(code)) return null;
  return {
    code,
    name: String(room.name || "Game").slice(0, 32),
    host: String(room.host || "").slice(0, 20),
    status: room.status === "full" ? "full" : "open",
    build: Number(room.build) >>> 0,
    since: Number(room.since) || Date.now(),
  };
}

export class Lobby {
  constructor(broker, onChange) {
    this.broker = broker;
    this.onChange = onChange;
    this.state = "connecting"; // connecting | keeper | member
    this.rooms = [];
    this.online = 0;
    this.mine = null;      // the room this page is hosting, if listed
    this.peer = null;
    this.link = null;      // member: the link to the keeper
    this.members = null;   // keeper: link -> that member's room (or null)
    this.failures = 0;
    this.timer = 0;
  }

  start() { this.claim(); }

  // --- this page's own room ---------------------------------------------------------
  host(room) { this.mine = clean({ ...room, since: Date.now() }); this.announce(); }
  update(patch) { if (this.mine) { this.mine = clean({ ...this.mine, ...patch }); this.announce(); } }
  unhost() { this.mine = null; this.announce(); }

  announce() {
    if (this.state === "keeper") this.broadcast();
    else if (this.state === "member" && this.link?.isOpen) this.link.send(this.mine ? { t: "room", room: this.mine } : { t: "unroom" });
  }

  // --- becoming the keeper, or a member ---------------------------------------------
  claim() {
    clearTimeout(this.timer);
    this.teardown();
    this.state = "connecting";
    this.changed();
    const p = new Peer(LOBBY_ID, this.broker);
    this.peer = p;
    p.on("open", () => {
      if (this.peer !== p) return;
      this.state = "keeper";
      this.failures = 0;
      this.members = new Map();
      p.on("connection", (link) => this.serve(link));
      this.broadcast();
    });
    p.on("error", (err) => {
      if (this.peer !== p) return;
      if (err.type === "unavailable-id") this.join();
      else this.retry();
    });
    // The broker lost this page, and with it the lobby's name: take it again.
    p.on("disconnected", () => { if (this.peer === p) this.retry(); });
  }

  join() {
    this.teardown();
    const p = new Peer(MEMBER_PREFIX + randomId(), this.broker);
    this.peer = p;
    const giveUp = setTimeout(() => { if (this.peer === p && this.state !== "member") this.retry(); }, 15000);
    p.on("open", () => {
      if (this.peer !== p) return;
      const link = p.connect(LOBBY_ID);
      this.link = link;
      link.on("open", () => {
        if (this.peer !== p) return;
        clearTimeout(giveUp);
        this.state = "member";
        this.failures = 0;
        if (this.mine) link.send({ t: "room", room: this.mine });
        this.changed();
      });
      link.on("data", (m) => {
        if (this.peer === p && m?.t === "rooms" && Array.isArray(m.rooms)) {
          this.rooms = m.rooms.map(clean).filter(Boolean);
          this.online = Number(m.online) || 0;
          this.changed();
        }
      });
      link.on("close", () => { if (this.peer === p) this.retry(); });
    });
    p.on("error", () => { if (this.peer === p) this.retry(); });
  }

  // Try again for the keeper's name after a while: soon at first, then less
  // often, and always with some randomness so a crowd does not try in step.
  retry() {
    this.teardown();
    this.state = "connecting";
    this.changed();
    this.failures++;
    const wait = Math.min(15000, 400 * 2 ** Math.min(this.failures, 5)) * (0.5 + Math.random());
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.claim(), wait);
  }

  teardown() {
    const p = this.peer;
    this.peer = null;
    this.link = null;
    this.members = null;
    try { p?.destroy(); } catch {}
  }

  // --- the keeper's side ----------------------------------------------------------------
  serve(link) {
    this.members.set(link, null);
    link.on("open", () => { link.send(this.listMessage()); this.broadcast(); });
    link.on("data", (m) => {
      if (!this.members?.has(link) || !m || typeof m !== "object") return;
      if (m.t === "room") this.members.set(link, clean(m.room));
      else if (m.t === "unroom") this.members.set(link, null);
      else return;
      this.broadcast();
    });
    link.on("close", () => { if (this.members?.delete(link)) this.broadcast(); });
  }

  list() {
    const all = [];
    if (this.mine) all.push(this.mine);
    for (const r of this.members?.values() || []) if (r) all.push(r);
    // One entry per code (a member that reconnected may briefly be listed twice).
    const seen = new Set();
    return all.filter((r) => !seen.has(r.code) && seen.add(r.code)).slice(0, MAX_ROOMS);
  }

  listMessage() {
    return { t: "rooms", rooms: this.list(), online: 1 + (this.members?.size || 0) };
  }

  broadcast() {
    if (this.state !== "keeper") return;
    const msg = this.listMessage();
    for (const link of this.members.keys()) if (link.isOpen) link.send(msg);
    this.rooms = msg.rooms;
    this.online = msg.online;
    this.changed();
  }

  changed() { try { this.onChange?.(this); } catch (e) { console.warn(e); } }
}

// Peer-to-peer links between two browsers: WebRTC data channels, introduced
// through a signaling broker that speaks the PeerJS server protocol. That is
// either the free public PeerJS cloud (the default) or `server.mjs` beside this
// file, which serves the game and brokers for it on one port.
//
// The broker only introduces the two browsers (an offer, an answer, network
// candidates); the game itself then flows directly between them.
//
// Protocol, as the PeerJS server has it: a WebSocket to
// `<broker>?key=peerjs&id=<id>&token=<t>`, answered with {type:"OPEN"} (or
// "ID-TAKEN"/"ERROR"); then {type, dst, payload} out and {type, src, payload}
// in, with "HEARTBEAT" every few seconds and "EXPIRE" when a message's
// destination never turned up.

export const PUBLIC_BROKER = "wss://0.peerjs.com/peerjs";

export const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  // PeerJS's public relay, for networks that cannot connect directly.
  { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"],
    username: "peerjs", credential: "peerjsp" },
];

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.handlers[ev] || []) fn(...a); }
}

function token() { return Math.random().toString(36).slice(2, 12); }

// A name on the broker, through which links are offered and accepted.
export class Peer extends Emitter {
  constructor(id, broker = PUBLIC_BROKER) {
    super();
    this.id = id;
    this.links = new Map();
    this.closed = false;
    const sep = broker.includes("?") ? "&" : "?";
    this.ws = new WebSocket(`${broker}${sep}key=peerjs&id=${encodeURIComponent(id)}&token=${token()}&version=1.5.4`);
    this.ws.onmessage = (e) => this.onSignal(JSON.parse(e.data));
    this.ws.onerror = () => { if (!this.opened) this.fail("network", "Could not reach the connection broker."); };
    this.ws.onclose = () => { clearInterval(this.beat); if (!this.closed && this.opened) this.emit("disconnected"); };
  }

  fail(type, message) {
    const err = new Error(message);
    err.type = type;
    this.emit("error", err);
  }

  send(msg) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(msg)); }

  onSignal(m) {
    switch (m.type) {
      case "OPEN":
        this.opened = true;
        this.beat = setInterval(() => this.send({ type: "HEARTBEAT" }), 5000);
        this.emit("open", this.id);
        break;
      case "ID-TAKEN": this.fail("unavailable-id", "That room code is taken."); break;
      case "INVALID-KEY": case "ERROR": this.fail("server-error", m.payload?.msg || "The broker refused the connection."); break;
      case "EXPIRE": {
        const link = this.links.get(m.src);
        if (link && !link.isOpen) { link.close(); this.fail("peer-unavailable", "No room with that code."); }
        break;
      }
      case "OFFER": {
        if (this.links.has(m.src)) this.links.get(m.src).close();
        const link = new Link(this, m.src, false);
        this.links.set(m.src, link);
        this.emit("connection", link);
        link.acceptOffer(m.payload.sdp);
        break;
      }
      case "ANSWER": this.links.get(m.src)?.acceptAnswer(m.payload.sdp); break;
      case "CANDIDATE": this.links.get(m.src)?.addCandidate(m.payload.candidate); break;
      case "LEAVE": this.links.get(m.src)?.close(); break;
    }
  }

  connect(dst) {
    const link = new Link(this, dst, true);
    this.links.set(dst, link);
    link.makeOffer();
    return link;
  }

  destroy() {
    this.closed = true;
    for (const l of this.links.values()) l.close();
    clearInterval(this.beat);
    try { this.ws.close(); } catch {}
  }
}

// One browser-to-browser channel: ordered and reliable. `send` takes an object
// (sent as JSON) or an ArrayBuffer / typed array (sent as binary).
export class Link extends Emitter {
  constructor(peer, remote, initiator) {
    super();
    this.peer = peer;
    this.remote = remote;
    this.isOpen = false;
    this.pending = [];
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.pc.onicecandidate = (e) => {
      if (e.candidate) peer.send({ type: "CANDIDATE", dst: remote, payload: { candidate: e.candidate.toJSON(), type: "data" } });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed") { this.emit("error", new Error("The direct connection failed. One of your networks may be blocking it.")); this.close(); }
      if (s === "closed" || s === "disconnected") setTimeout(() => { if (this.pc.connectionState !== "connected") this.close(); }, s === "disconnected" ? 4000 : 0);
    };
    if (initiator) this.setChannel(this.pc.createDataChannel("zamn", { ordered: true }));
    else this.pc.ondatachannel = (e) => this.setChannel(e.channel);
  }

  setChannel(ch) {
    this.ch = ch;
    ch.binaryType = "arraybuffer";
    ch.onopen = () => { this.isOpen = true; this.emit("open"); };
    ch.onclose = () => this.close();
    ch.onmessage = (e) => this.emit("data", typeof e.data === "string" ? JSON.parse(e.data) : e.data);
  }

  async makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.peer.send({ type: "OFFER", dst: this.remote, payload: { sdp: this.pc.localDescription.toJSON(), type: "data" } });
  }

  async acceptOffer(sdp) {
    await this.pc.setRemoteDescription(sdp);
    this.flushCandidates();
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.peer.send({ type: "ANSWER", dst: this.remote, payload: { sdp: this.pc.localDescription.toJSON(), type: "data" } });
  }

  async acceptAnswer(sdp) {
    await this.pc.setRemoteDescription(sdp);
    this.flushCandidates();
  }

  addCandidate(c) {
    if (!this.pc.remoteDescription) { this.pending.push(c); return; }
    this.pc.addIceCandidate(c).catch(() => {});
  }
  flushCandidates() { for (const c of this.pending.splice(0)) this.pc.addIceCandidate(c).catch(() => {}); }

  send(m) {
    if (!this.ch || this.ch.readyState !== "open") return;
    if (m instanceof ArrayBuffer || ArrayBuffer.isView(m)) this.ch.send(m);
    else this.ch.send(JSON.stringify(m));
  }

  close() {
    if (this.closedOnce) return;
    this.closedOnce = true;
    this.isOpen = false;
    try { this.ch?.close(); } catch {}
    try { this.pc.close(); } catch {}
    if (this.peer.links.get(this.remote) === this) this.peer.links.delete(this.remote);
    this.emit("close");
  }
}

// 11D Mafia — Telegram Mini App o'yini (Cloudflare Worker + Durable Objects)
import APP_HTML from "./app.html";

// ---------------- sozlamalar ----------------
const T = { reveal: 7, night: 30, morning: 8, day: 90, vote: 30, verdict: 7, quickWait: 30, quickFull: 5 };
const MAX = 20, MIN_PRIVATE = 4, MIN_QUICK = 5;
const AVATARS = 8, COLORS = 6;
const MAFIA = new Set(["don", "mafia"]);
const ACTORS = new Set(["don", "mafia", "doktor", "komissar", "tansoqchi"]);
const ROLE_UZ = { don: "Don", mafia: "Mafia", doktor: "Doktor", komissar: "Komissar", tansoqchi: "Tansoqchi", tinch: "Tinch aholi" };
const ROLE_EMO = { don: "🎩", mafia: "🔫", doktor: "💉", komissar: "🕵️", tansoqchi: "🛡", tinch: "👨‍🌾" };
const LEVELS = [[0, "🐣 Yangi"], [5, "🚶 Ko'cha bolasi"], [15, "🎩 Bandit"], [30, "🕴 Don"], [50, "👑 Godfather"]];

const now = () => Date.now();
const today = () => new Date(now() + 5 * 3600e3).toISOString().slice(0, 10); // Toshkent
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const levelOf = (pts) => {
  let cur = LEVELS[0], next = null;
  for (const l of LEVELS) { if (pts >= l[0]) cur = l; else { next = l; break; } }
  return { name: cur[1], next: next ? next[0] : null };
};
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });

// ---------------- Telegram ----------------
async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    return await r.json();
  } catch { return { ok: false }; }
}

let botUsername = null;
async function getBotUsername(env) {
  if (!botUsername) { const r = await tg(env, "getMe", {}); botUsername = r.ok ? r.result.username : null; }
  return botUsername;
}

async function verifyInit(initData, env) {
  if (!initData) return null;
  if (env.DEV === "1" && initData.startsWith("dev:")) {
    const [, id, name] = initData.split(":");
    return { id: Number(id), name: (name || "Test").slice(0, 24) };
  }
  if (!env.BOT_TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get("hash");
  if (!hash) return null;
  p.delete("hash");
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", k1, enc.encode(env.BOT_TOKEN));
  const k2 = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", k2, enc.encode(dcs)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (sig !== hash) return null;
  if (now() / 1000 - Number(p.get("auth_date") || 0) > 86400) return null;
  try {
    const u = JSON.parse(p.get("user"));
    return { id: u.id, name: String(u.first_name || u.username || "O'yinchi").slice(0, 24) };
  } catch { return null; }
}

const hub = (env) => env.HUB.get(env.HUB.idFromName("hub"));
const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName("room:" + code));
const call = async (stub, body) => (await stub.fetch("https://do/", { method: "POST", body: JSON.stringify(body) })).json();

// ---------------- Worker ----------------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/" || path === "/index.html") {
      return new Response(APP_HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    }

    if (path === "/tg" && req.method === "POST") {
      if (env.WEBHOOK_SECRET && req.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) return new Response("no", { status: 403 });
      const upd = await req.json().catch(() => null);
      if (upd) ctx.waitUntil(onUpdate(env, upd, url.origin).catch((e) => console.log("tg xato", e && e.stack)));
      return new Response("ok");
    }

    if (path === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("websocket kerak", { status: 426 });
      const user = await verifyInit(url.searchParams.get("init"), env);
      const code = (url.searchParams.get("code") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
      if (!user || !code) return new Response("ruxsat yo'q", { status: 403 });
      const h = new Headers(req.headers);
      h.set("X-User", JSON.stringify(user));
      h.set("X-Code", code);
      return roomStub(env, code).fetch(new Request(req, { headers: h }));
    }

    if (path.startsWith("/api/") && req.method === "POST") {
      const user = await verifyInit(req.headers.get("X-Init"), env);
      if (!user) return json({ error: "Botdan qayta oching" }, 403);
      const body = await req.json().catch(() => ({}));
      const op = path.slice(5);
      if (op === "home") {
        const d = await call(hub(env), { op: "home", user });
        d.bot = env.BOT_TOKEN ? await getBotUsername(env) : null;
        return json(d);
      }
      if (op === "quick") return json(await call(hub(env), { op: "quick" }));
      if (op === "create") return json(await call(hub(env), { op: "create", kind: "private" }));
      if (op === "check") {
        const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
        if (!code) return json({ ok: false });
        const info = await call(roomStub(env, code), { op: "info" });
        return json({ ok: !!info.kind, code, info });
      }
      return json({ error: "noma'lum" }, 404);
    }

    return new Response("Not found", { status: 404 });
  },
};

async function onUpdate(env, u, origin) {
  const m = u.message;
  if (!m || !m.text) return;
  const chat = m.chat.id;
  const isGroup = m.chat.type === "group" || m.chat.type === "supergroup";
  const cmd = m.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

  if (cmd === "/start" && !isGroup) {
    return tg(env, "sendMessage", {
      chat_id: chat,
      text: "🎭 11D Mafia\n\nShahar uxlaydi, mafia uyg'onadi. Pastdagi tugmani bos va o'yna!\n\nGuruhda o'ynash: botni guruhga qo'sh va /mafia yoz.",
      reply_markup: { inline_keyboard: [[{ text: "🎭 O'ynash", web_app: { url: origin + "/" } }]] },
    });
  }
  if (cmd === "/mafia" || cmd === "/yangi" || (cmd === "/start" && isGroup)) {
    if (!isGroup) {
      return tg(env, "sendMessage", { chat_id: chat, text: "Bu komanda guruh uchun. Bu yerda o'ynash uchun 👇", reply_markup: { inline_keyboard: [[{ text: "🎭 O'ynash", web_app: { url: origin + "/" } }]] } });
    }
    const r = await call(hub(env), { op: "create", kind: "group", chat, title: m.chat.title || "" });
    const bu = await getBotUsername(env);
    if (!bu) return tg(env, "sendMessage", { chat_id: chat, text: "Xato: bot tokenini tekshiring." });
    return tg(env, "sendMessage", {
      chat_id: chat,
      text: `🎭 11D Mafia — xona ${r.code}\n\nKirish uchun tugmani bosing 👇\nKamida ${MIN_PRIVATE} kishi kerak. Xonani birinchi kirgan odam boshlaydi.`,
      reply_markup: { inline_keyboard: [[{ text: "🎭 Qo'shilish", url: `https://t.me/${bu}?startapp=${r.code}` }]] },
    });
  }
  if (cmd === "/reyting" || cmd === "/top") {
    const r = await call(hub(env), { op: "top", chat: isGroup ? chat : null });
    if (!r.top.length) return tg(env, "sendMessage", { chat_id: chat, text: "Bugun hali hech kim ball olmagan." });
    const lines = r.top.map((x, i) => `${i + 1}. ${x.name} — ${x.pts} ball, ${x.wins}/${x.games} yutuq · ${levelOf(x.pts).name}`);
    return tg(env, "sendMessage", { chat_id: chat, text: (isGroup ? "🏆 Guruhning bugungi reytingi:\n" : "🏆 Bugungi top:\n") + lines.join("\n") });
  }
  if (cmd === "/men") {
    const r = await call(hub(env), { op: "home", user: { id: m.from.id, name: m.from.first_name } });
    const me = r.me;
    return tg(env, "sendMessage", { chat_id: chat, text: `👤 ${m.from.first_name}\nBugun: ${me.today} ball · ${me.level}\nUmumiy: ${me.total} ball, ${me.games} o'yin, ${me.wins} yutuq` });
  }
}

// ---------------- Hub: matchmaking + reyting ----------------
export class Hub {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms(code TEXT PRIMARY KEY, kind TEXT, chat INTEGER, created INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily(day TEXT, uid INTEGER, name TEXT, pts INTEGER, games INTEGER, wins INTEGER, PRIMARY KEY(day, uid))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS chatdaily(day TEXT, chat INTEGER, uid INTEGER, name TEXT, pts INTEGER, games INTEGER, wins INTEGER, PRIMARY KEY(day, chat, uid))`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS total(uid INTEGER PRIMARY KEY, name TEXT, pts INTEGER, games INTEGER, wins INTEGER)`);
  }

  rows(q, ...a) { return this.sql.exec(q, ...a).toArray(); }

  async fetch(req) {
    const b = await req.json();
    if (b.op === "home") return json(await this.home(b.user));
    if (b.op === "quick") return json(await this.quick());
    if (b.op === "create") return json(await this.create(b.kind, b.chat || null));
    if (b.op === "top") return json({ top: this.top(b.chat) });
    if (b.op === "record") { this.record(b.results, b.chat); return json({ ok: true }); }
    return json({ error: "op" }, 400);
  }

  async quickCode() {
    const r = this.rows(`SELECT v FROM kv WHERE k='quick'`)[0];
    return r ? r.v : null;
  }

  async quick() {
    let code = await this.quickCode();
    if (code) {
      const info = await call(roomStub(this.env, code), { op: "info" });
      if (info.joinable) return { code };
    }
    code = await this.newCode("Q");
    await call(roomStub(this.env, code), { op: "init", kind: "quick", code, chat: null });
    this.sql.exec(`INSERT OR REPLACE INTO kv(k, v) VALUES('quick', ?)`, code);
    this.sql.exec(`INSERT OR REPLACE INTO rooms(code, kind, chat, created) VALUES(?,?,?,?)`, code, "quick", null, now());
    return { code };
  }

  async newCode(prefix = "") {
    for (let i = 0; i < 30; i++) {
      const code = prefix + String(1000 + Math.floor(Math.random() * 9000));
      const r = this.rows(`SELECT created FROM rooms WHERE code=?`, code)[0];
      if (r && now() - r.created < 6 * 3600e3) continue;
      const info = await call(roomStub(this.env, code), { op: "info" });
      if (info.kind && info.count > 0) continue;
      return code;
    }
    return prefix + String(now()).slice(-6);
  }

  async create(kind, chat) {
    const code = await this.newCode("");
    await call(roomStub(this.env, code), { op: "init", kind, code, chat });
    this.sql.exec(`INSERT OR REPLACE INTO rooms(code, kind, chat, created) VALUES(?,?,?,?)`, code, kind, chat, now());
    return { code };
  }

  async home(user) {
    let waiting = 0;
    const code = await this.quickCode();
    if (code) {
      const info = await call(roomStub(this.env, code), { op: "info" });
      if (info.joinable) waiting = info.count;
    }
    const d = this.rows(`SELECT pts FROM daily WHERE day=? AND uid=?`, today(), user.id)[0];
    const t = this.rows(`SELECT * FROM total WHERE uid=?`, user.id)[0] || { pts: 0, games: 0, wins: 0 };
    const pts = d ? d.pts : 0;
    const lv = levelOf(pts);
    return {
      waiting,
      me: { name: user.name, today: pts, level: lv.name, next: lv.next, total: t.pts, games: t.games, wins: t.wins },
      top: this.top(null),
    };
  }

  top(chat) {
    const rows = chat
      ? this.rows(`SELECT name, pts, games, wins, uid FROM chatdaily WHERE day=? AND chat=? ORDER BY pts DESC, wins DESC LIMIT 10`, today(), chat)
      : this.rows(`SELECT name, pts, games, wins, uid FROM daily WHERE day=? ORDER BY pts DESC, wins DESC LIMIT 10`, today());
    return rows.map((r) => ({ ...r, level: levelOf(r.pts).name }));
  }

  record(results, chat) {
    const day = today();
    for (const r of results) {
      const w = r.won ? 1 : 0;
      this.sql.exec(`INSERT INTO daily(day, uid, name, pts, games, wins) VALUES(?,?,?,?,1,?)
        ON CONFLICT(day, uid) DO UPDATE SET name=excluded.name, pts=pts+excluded.pts, games=games+1, wins=wins+excluded.wins`, day, r.id, r.name, r.pts, w);
      this.sql.exec(`INSERT INTO total(uid, name, pts, games, wins) VALUES(?,?,?,1,?)
        ON CONFLICT(uid) DO UPDATE SET name=excluded.name, pts=pts+excluded.pts, games=games+1, wins=wins+excluded.wins`, r.id, r.name, r.pts, w);
      if (chat) this.sql.exec(`INSERT INTO chatdaily(day, chat, uid, name, pts, games, wins) VALUES(?,?,?,?,?,1,?)
        ON CONFLICT(day, chat, uid) DO UPDATE SET name=excluded.name, pts=pts+excluded.pts, games=games+1, wins=wins+excluded.wins`, day, chat, r.id, r.name, r.pts, w);
    }
    // eski kunlarni tozalash
    const old = new Date(now() - 8 * 86400e3 + 5 * 3600e3).toISOString().slice(0, 10);
    this.sql.exec(`DELETE FROM daily WHERE day<?`, old);
    this.sql.exec(`DELETE FROM chatdaily WHERE day<?`, old);
  }
}

// ---------------- Room: bitta xona = bitta o'yin ----------------
export class Room {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.meta = null; // {kind, code, chat}
    this.sockets = new Map(); // ws -> uid
    this.spectators = new Set();
    this.botN = 0;
    this.timer = null;
    this.reset();
    ctx.blockConcurrencyWhile(async () => { this.meta = (await ctx.storage.get("meta")) || null; });
  }

  reset(keepPlayers = false) {
    clearTimeout(this.timer); this.timer = null;
    const old = keepPlayers ? this.players : null;
    this.players = new Map();
    if (old) for (const p of old.values()) {
      if (p.isBot || p.online) this.players.set(p.id, { ...p, role: null, alive: true });
    }
    this.phase = "lobby"; this.round = 0; this.deadline = 0;
    this.acts = {}; this.votes = new Map(); this.skips = new Set();
    this.lastHeal = null; this.news = null; this.winner = null; this.results = null;
    this.notes = new Map(); this.log = []; this.lastMsg = new Map(); this.msgId = 0;
    if (!keepPlayers) this.hostId = null;
  }

  // ---- yordamchilar ----
  alive() { return [...this.players.values()].filter((p) => p.alive); }
  humans() { return [...this.players.values()].filter((p) => !p.isBot); }
  isMafia(p) { return p && MAFIA.has(p.role); }

  schedule(secs, phase) {
    clearTimeout(this.timer);
    this.deadline = secs ? now() + secs * 1000 : 0;
    if (secs) this.timer = setTimeout(() => this.tick(phase), secs * 1000 + 50);
  }

  async fetch(req) {
    if (req.headers.get("Upgrade") === "websocket") return this.connect(req);
    const b = await req.json();
    if (b.op === "info") {
      const count = this.players.size;
      const joinable = !!this.meta && this.phase === "lobby" && count < MAX;
      return json({ kind: this.meta ? this.meta.kind : null, phase: this.phase, count, joinable });
    }
    if (b.op === "init") {
      for (const ws of this.sockets.keys()) { try { ws.close(1000, "reset"); } catch {} }
      this.sockets.clear(); this.spectators.clear();
      this.meta = { kind: b.kind, code: b.code, chat: b.chat || null };
      await this.ctx.storage.put("meta", this.meta);
      this.reset();
      return json({ ok: true });
    }
    return json({ error: "op" }, 400);
  }

  connect(req) {
    const user = JSON.parse(req.headers.get("X-User"));
    const url = new URL(req.url);
    const pair = new WebSocketPair();
    const [client, ws] = Object.values(pair);
    ws.accept();
    const fail = (text) => { ws.send(JSON.stringify({ t: "error", text })); ws.close(4000, "x"); return new Response(null, { status: 101, webSocket: client }); };
    if (!this.meta) return fail("Bunday xona yo'q. Kodni tekshiring.");

    let p = this.players.get(user.id);
    if (!p) {
      if (this.phase !== "lobby") {
        this.spectators.add(ws);
        this.sockets.set(ws, null);
        this.bind(ws, null);
        this.send(ws, { t: "state", s: this.view(null) });
        this.send(ws, { t: "history", log: this.visibleLog(null) });
        this.send(ws, { t: "toast", text: "O'yin ketyapti — siz tomoshabinsiz" });
        return new Response(null, { status: 101, webSocket: client });
      }
      if (this.players.size >= MAX) return fail("Xona to'la (20/20).");
      const a = Number(url.searchParams.get("a")), c = Number(url.searchParams.get("c"));
      p = {
        id: user.id, name: user.name, isBot: false, role: null, alive: true, online: true,
        avatar: Number.isInteger(a) && a >= 0 && a < AVATARS ? a : Math.floor(Math.random() * AVATARS),
        color: Number.isInteger(c) && c >= 0 && c < COLORS ? c : Math.floor(Math.random() * COLORS),
      };
      this.players.set(p.id, p);
      this.sys(`${p.name} xonaga kirdi`);
    } else {
      for (const [s, uid] of this.sockets) if (uid === p.id && s !== ws) { try { s.close(4001, "boshqa joydan kirdi"); } catch {} this.sockets.delete(s); }
      p.online = true; p.name = user.name;
    }
    if (!this.hostId || !this.players.has(this.hostId) || this.players.get(this.hostId).isBot) this.hostId = p.id;
    this.sockets.set(ws, p.id);
    this.bind(ws, p.id);
    this.send(ws, { t: "history", log: this.visibleLog(p) });
    this.lobbyCheck();
    this.broadcast();
    return new Response(null, { status: 101, webSocket: client });
  }

  bind(ws, uid) {
    ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      try { this.onMsg(ws, uid, m); } catch (err) { console.log("xato", err && err.stack); }
    });
    const gone = () => this.onClose(ws, uid);
    ws.addEventListener("close", gone);
    ws.addEventListener("error", gone);
  }

  onClose(ws, uid) {
    if (!this.sockets.has(ws)) return;
    this.sockets.delete(ws); this.spectators.delete(ws);
    if (uid == null) return;
    const p = this.players.get(uid);
    if (!p || [...this.sockets.values()].includes(uid)) return;
    if (this.phase === "lobby") this.removePlayer(uid);
    else { p.online = false; this.broadcast(); }
  }

  removePlayer(uid) {
    const p = this.players.get(uid);
    if (!p) return;
    this.players.delete(uid);
    this.sys(`${p.name} chiqib ketdi`);
    if (this.hostId === uid) {
      const h = this.humans().find((x) => x.online);
      this.hostId = h ? h.id : null;
    }
    this.lobbyCheck();
    this.broadcast();
  }

  send(ws, d) { try { ws.send(JSON.stringify(d)); } catch {} }

  broadcast() {
    for (const [ws, uid] of this.sockets) this.send(ws, { t: "state", s: this.view(uid) });
  }

  // ---- chat ----
  canSee(msg, p) {
    if (msg.ch === "mafia") return this.phase === "end" || (p && this.isMafia(p));
    return true;
  }
  visibleLog(p) { return this.log.filter((m) => this.canSee(m, p)); }
  pushMsg(msg) {
    msg.id = ++this.msgId; msg.at = now();
    this.log.push(msg);
    if (this.log.length > 100) this.log.shift();
    for (const [ws, uid] of this.sockets) {
      const p = uid != null ? this.players.get(uid) : null;
      if (this.canSee(msg, p)) this.send(ws, { t: "msg", m: msg });
    }
  }
  sys(text) { this.pushMsg({ ch: "sys", text }); }

  chatBlock(p) {
    if (!p) return "Tomoshabinlar yozolmaydi";
    if (this.phase === "lobby" || this.phase === "end") return null;
    if (!p.alive) return "O'liklar gapirmaydi 💀";
    if (this.phase === "reveal") return "Hozir yozib bo'lmaydi";
    if (this.phase === "night") return this.isMafia(p) ? null : "Tunda aholi jim...";
    return null;
  }

  // ---- xabarlar ----
  onMsg(ws, uid, m) {
    const p = uid != null ? this.players.get(uid) : null;
    const err = (text) => this.send(ws, { t: "toast", text, bad: true });
    switch (m.t) {
      case "ping": return this.send(ws, { t: "pong" });
      case "chat": case "emo": {
        const block = this.chatBlock(p);
        if (block) return err(block);
        const last = this.lastMsg.get(uid) || 0;
        if (now() - last < 600) return;
        this.lastMsg.set(uid, now());
        const text = String(m.text || "").replace(/\s+/g, " ").trim().slice(0, 200);
        if (!text) return;
        const ch = this.phase === "night" ? "mafia" : "all";
        return this.pushMsg({ ch, uid, name: p.name, avatar: p.avatar, color: p.color, text, emo: m.t === "emo" });
      }
      case "look": {
        if (!p || this.phase !== "lobby") return;
        const a = Number(m.avatar), c = Number(m.color);
        if (Number.isInteger(a) && a >= 0 && a < AVATARS) p.avatar = a;
        if (Number.isInteger(c) && c >= 0 && c < COLORS) p.color = c;
        return this.broadcast();
      }
      case "bot": {
        if (!p || uid !== this.hostId || this.phase !== "lobby" || this.meta.kind === "quick") return;
        if (this.players.size >= MAX) return err("Xona to'la");
        const k = ++this.botN, id = -k;
        this.players.set(id, { id, name: `Bot ${k}`, isBot: true, role: null, alive: true, online: true, avatar: Math.floor(Math.random() * AVATARS), color: Math.floor(Math.random() * COLORS) });
        return this.broadcast();
      }
      case "kick": {
        if (!p || uid !== this.hostId || this.phase !== "lobby") return;
        const t = this.players.get(Number(m.id));
        if (t && t.isBot) { this.players.delete(t.id); this.broadcast(); }
        return;
      }
      case "start": {
        if (!p || uid !== this.hostId || this.phase !== "lobby" || this.meta.kind === "quick") return;
        if (this.players.size < MIN_PRIVATE) return err(`Kamida ${MIN_PRIVATE} o'yinchi kerak`);
        return this.start();
      }
      case "again": {
        if (!p || uid !== this.hostId || this.phase !== "end" || this.meta.kind === "quick") return;
        this.reset(true);
        this.sys("Yangi o'yin! Xona ochiq");
        return this.broadcast();
      }
      case "act": return this.act(ws, p, Number(m.target));
      case "skip": {
        if (!p || !p.alive || this.phase !== "day") return;
        if (this.skips.has(uid)) this.skips.delete(uid); else this.skips.add(uid);
        if (this.skips.size >= this.skipNeed()) return this.startVote();
        return this.broadcast();
      }
      case "vote": {
        if (!p || !p.alive || this.phase !== "vote") return;
        const t = Number(m.target);
        if (t !== 0) { const tp = this.players.get(t); if (!tp || !tp.alive || t === uid) return err("Bunga ovoz berib bo'lmaydi"); }
        this.votes.set(uid, t);
        if (this.alive().filter((x) => !x.isBot && x.online).every((x) => this.votes.has(x.id)) && this.deadline - now() > 1500) return this.schedule(1.5, "vote");
        return this.broadcast();
      }
      case "leave": {
        if (!p) { this.sockets.delete(ws); this.spectators.delete(ws); return; }
        this.sockets.delete(ws);
        if (this.phase === "lobby") return this.removePlayer(uid);
        if (this.phase === "end") { p.online = false; return this.broadcast(); }
        p.online = false;
        if (p.alive) {
          p.alive = false;
          this.sys(`🚪 ${p.name} o'yindan chiqib ketdi. U ${ROLE_UZ[p.role]} edi`);
          if (this.checkWin()) return;
        }
        return this.broadcast();
      }
    }
  }

  skipNeed() {
    const n = this.alive().filter((x) => !x.isBot && x.online).length;
    return Math.max(1, Math.ceil(n * 2 / 3));
  }

  lobbyCheck() {
    if (this.phase !== "lobby" || !this.meta || this.meta.kind !== "quick") return;
    const n = this.players.size;
    if (n >= MAX) { if (!this.deadline || this.deadline - now() > T.quickFull * 1000) this.schedule(T.quickFull, "lobby"); }
    else if (n >= MIN_QUICK) { if (!this.deadline) this.schedule(T.quickWait, "lobby"); }
    else if (this.deadline) this.schedule(0);
  }

  // ---- o'yin ----
  start() {
    for (const p of [...this.players.values()]) if (!p.isBot && !p.online) this.players.delete(p.id);
    const ps = [...this.players.values()];
    const n = ps.length;
    if (n < (this.meta.kind === "quick" ? MIN_QUICK : MIN_PRIVATE) || !ps.some((p) => !p.isBot)) { this.schedule(0); return this.broadcast(); }
    const nm = Math.max(1, Math.floor(n / 4));
    const roles = ["don", ...Array(nm - 1).fill("mafia"), "doktor"];
    if (n >= 5) roles.push("komissar");
    if (n >= 8) roles.push("tansoqchi");
    while (roles.length < n) roles.push("tinch");
    shuffle(roles);
    ps.forEach((p, i) => { p.role = roles[i]; p.alive = true; });
    this.round = 0;
    this.log = this.log.filter((m) => m.ch !== "mafia");
    this.phase = "reveal";
    this.sys(`🎬 O'yin boshlandi! ${n} o'yinchi, ${nm} mafia`);
    this.schedule(T.reveal, "reveal");
    this.broadcast();
    if (this.meta.kind === "group" && this.meta.chat) {
      tg(this.env, "sendMessage", { chat_id: this.meta.chat, text: `🎬 11D Mafia boshlandi! Xona ${this.meta.code}, ${n} o'yinchi.` });
    }
  }

  tick(phase) {
    if (phase !== this.phase) return;
    if (phase === "lobby") return this.start();
    if (phase === "reveal") return this.startNight();
    if (phase === "night") return this.endNight();
    if (phase === "morning") { if (!this.checkWin()) this.startDay(); return; }
    if (phase === "day") return this.startVote();
    if (phase === "vote") return this.endVote();
    if (phase === "verdict") { if (!this.checkWin()) this.startNight(); return; }
  }

  targetsFor(p) {
    if (!p || !p.alive || !ACTORS.has(p.role)) return [];
    const al = this.alive();
    if (MAFIA.has(p.role)) return al.filter((x) => !MAFIA.has(x.role)).map((x) => x.id);
    if (p.role === "doktor") return al.filter((x) => x.id !== this.lastHeal).map((x) => x.id);
    return al.filter((x) => x.id !== p.id).map((x) => x.id);
  }

  startNight() {
    this.round++;
    this.phase = "night";
    this.acts = {}; this.news = null; this.votes = new Map(); this.skips = new Set();
    for (const p of this.alive()) {
      if (!p.isBot || !ACTORS.has(p.role)) continue;
      const t = this.targetsFor(p);
      if (t.length) this.acts[p.id] = pick(t);
    }
    this.sys(`🌙 ${this.round}-tun. Shahar uxlaydi...`);
    this.schedule(T.night, "night");
    this.broadcast();
  }

  act(ws, p, target) {
    if (!p || this.phase !== "night") return;
    if (!p.alive || !ACTORS.has(p.role)) return this.send(ws, { t: "toast", text: "Siz uxlayapsiz 😴", bad: true });
    if (!this.targetsFor(p).includes(target)) {
      return this.send(ws, { t: "toast", text: p.role === "doktor" && target === this.lastHeal ? "Bir odamni ketma-ket davolab bo'lmaydi" : "Bu odamni tanlab bo'lmaydi", bad: true });
    }
    this.acts[p.id] = target;
    if (MAFIA.has(p.role)) {
      const t = this.players.get(target);
      this.pushMsg({ ch: "mafia", text: `${ROLE_EMO[p.role]} ${p.name} → ${t.name}`, sysm: true });
    }
    const pending = this.alive().filter((x) => !x.isBot && x.online && ACTORS.has(x.role) && this.targetsFor(x).length && !(x.id in this.acts));
    if (!pending.length && this.deadline - now() > 2000) return this.schedule(2, "night");
    this.broadcast();
  }

  endNight() {
    const al = this.alive();
    const don = al.find((p) => p.role === "don");
    const mafs = al.filter((p) => MAFIA.has(p.role));
    let victim = null;
    if (don && this.acts[don.id] != null) victim = this.acts[don.id];
    else {
      const c = {};
      for (const m of mafs) if (this.acts[m.id] != null) c[this.acts[m.id]] = (c[this.acts[m.id]] || 0) + 1;
      const top = Math.max(0, ...Object.values(c));
      if (top) victim = Number(pick(Object.keys(c).filter((k) => c[k] === top)));
    }
    const doc = al.find((p) => p.role === "doktor");
    const heal = doc && this.acts[doc.id] != null ? this.acts[doc.id] : null;
    const guard = al.find((p) => p.role === "tansoqchi");
    const guarded = guard && this.acts[guard.id] != null ? this.acts[guard.id] : null;
    const kom = al.find((p) => p.role === "komissar");

    const deaths = []; let saved = false, guardHit = false;
    if (victim != null && this.players.get(victim) && this.players.get(victim).alive) {
      if (guarded === victim && guard) {
        guardHit = true;
        if (heal !== guard.id) deaths.push(guard.id); else saved = true;
        const shooter = don || pick(mafs.filter((m) => this.acts[m.id] === victim)) || pick(mafs);
        if (shooter && heal !== shooter.id) deaths.push(shooter.id);
      } else if (heal === victim) saved = true;
      else deaths.push(victim);
    }
    if (kom && this.acts[kom.id] != null) {
      const t = this.players.get(this.acts[kom.id]);
      if (t) {
        const note = `${this.round}-tun: ${t.name} — ${MAFIA.has(t.role) ? "MAFIA 🔫" : "mafia emas ✅"}`;
        const arr = this.notes.get(kom.id) || []; arr.push(note); this.notes.set(kom.id, arr);
        for (const [ws, uid] of this.sockets) if (uid === kom.id) this.send(ws, { t: "toast", text: "🕵️ " + note });
      }
    }
    this.lastHeal = heal;
    for (const id of deaths) this.players.get(id).alive = false;
    this.news = {
      kind: "morning",
      deaths: deaths.map((id) => { const p = this.players.get(id); return { id, name: p.name, role: p.role, avatar: p.avatar, color: p.color }; }),
      saved, guardHit,
    };
    this.sys(deaths.length
      ? `☀️ Tong. O'ldirildi: ${deaths.map((id) => { const p = this.players.get(id); return `${p.name} (${ROLE_UZ[p.role]})`; }).join(", ")}`
      : saved ? "☀️ Tong. Doktor kimnidir qutqarib qoldi!" : "☀️ Tong. Bu tun hech kim o'lmadi");
    this.phase = "morning";
    this.schedule(T.morning, "morning");
    this.broadcast();
  }

  startDay() {
    this.phase = "day";
    this.skips = new Set();
    this.schedule(T.day, "day");
    this.broadcast();
  }

  startVote() {
    this.phase = "vote";
    this.votes = new Map();
    const al = this.alive();
    for (const p of al) {
      if (!p.isBot) continue;
      const opts = al.filter((x) => x.id !== p.id && !(MAFIA.has(p.role) && MAFIA.has(x.role)));
      this.votes.set(p.id, opts.length && Math.random() < 0.85 ? pick(opts).id : 0);
    }
    this.sys("🗳 Ovoz berish! Kimni osamiz?");
    this.schedule(T.vote, "vote");
    this.broadcast();
  }

  voteCounts() {
    const c = {};
    for (const t of this.votes.values()) if (t) c[t] = (c[t] || 0) + 1;
    return c;
  }

  endVote() {
    const c = this.voteCounts();
    const sorted = Object.entries(c).sort((a, b) => b[1] - a[1]);
    let hanged = null;
    if (sorted.length && (sorted.length === 1 || sorted[0][1] > sorted[1][1])) {
      const p = this.players.get(Number(sorted[0][0]));
      if (p && p.alive) { p.alive = false; hanged = { id: p.id, name: p.name, role: p.role, avatar: p.avatar, color: p.color, votes: sorted[0][1] }; }
    }
    this.news = { kind: "verdict", hanged };
    this.sys(hanged ? `⚖️ Shahar ${hanged.name}ni osdi (${hanged.votes} ovoz). U ${ROLE_UZ[hanged.role]} edi` : "⚖️ Ovozlar teng — hech kim osilmadi");
    this.phase = "verdict";
    this.schedule(T.verdict, "verdict");
    this.broadcast();
  }

  checkWin() {
    const al = this.alive();
    const m = al.filter((p) => MAFIA.has(p.role)).length;
    let w = null;
    if (m === 0) w = "tinch";
    else if (m >= al.length - m) w = "mafia";
    if (!w) return false;
    this.finish(w);
    return true;
  }

  finish(w) {
    this.phase = "end"; this.winner = w;
    this.schedule(0);
    const results = [];
    for (const p of this.players.values()) {
      const won = (w === "mafia") === MAFIA.has(p.role);
      const pts = 1 + (won ? 3 : 0) + (p.alive ? 1 : 0);
      p.won = won; p.pts = pts;
      if (!p.isBot) results.push({ id: p.id, name: p.name, pts, won });
    }
    this.results = results;
    this.sys(w === "mafia" ? "🔫 Mafia yutdi!" : "🏆 Tinch aholi yutdi!");
    this.broadcast();
    if (results.length) {
      call(hub(this.env), { op: "record", results, chat: this.meta.chat }).catch(() => {});
    }
    if (this.meta.kind === "group" && this.meta.chat) {
      const lines = [...this.players.values()].map((p) => `${p.alive ? "" : "☠️ "}${p.name} — ${ROLE_EMO[p.role]} ${ROLE_UZ[p.role]}${p.won ? " ✅" : ""}`);
      tg(this.env, "sendMessage", { chat_id: this.meta.chat, text: `${w === "mafia" ? "🔫 Mafia yutdi!" : "🏆 Tinch aholi yutdi!"}\n\n${lines.join("\n")}\n\n/reyting — bugungi reyting\n/mafia — yana o'ynash` });
    }
  }

  // ---- har bir o'yinchi uchun holat ----
  view(uid) {
    const me = uid != null ? this.players.get(uid) : null;
    const end = this.phase === "end";
    const iMafia = me && this.isMafia(me) && this.phase !== "lobby";
    const counts = this.phase === "vote" || this.phase === "verdict" ? this.voteCounts() : {};
    const picks = {};
    if (iMafia && this.phase === "night") for (const p of this.alive()) if (MAFIA.has(p.role) && this.acts[p.id] != null) picks[p.id] = this.acts[p.id];
    const players = [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, avatar: p.avatar, color: p.color, bot: p.isBot, alive: p.alive, online: p.online,
      role: end || !p.alive || p.id === uid || (iMafia && MAFIA.has(p.role)) ? p.role : null,
      votes: counts[p.id] || 0,
      won: end ? p.won : undefined, pts: end && !p.isBot ? p.pts : undefined,
    }));
    let meV = null;
    if (me) {
      meV = {
        id: me.id, role: me.role, alive: me.alive,
        targets: this.phase === "night" ? this.targetsFor(me) : [],
        act: this.phase === "night" ? this.acts[me.id] ?? null : null,
        vote: this.votes.has(me.id) ? this.votes.get(me.id) : null,
        skipped: this.skips.has(me.id),
        notes: this.notes.get(me.id) || [],
        chatBlock: this.chatBlock(me),
        lastHeal: me.role === "doktor" ? this.lastHeal : null,
      };
    }
    return {
      code: this.meta ? this.meta.code : null, kind: this.meta ? this.meta.kind : null,
      phase: this.phase, round: this.round, deadline: this.deadline, serverNow: now(),
      hostId: this.hostId, max: MAX, min: this.meta && this.meta.kind === "quick" ? MIN_QUICK : MIN_PRIVATE,
      players, me: meV, picks, news: this.news, winner: this.winner,
      skip: { n: this.skips.size, need: this.phase === "day" ? this.skipNeed() : 0 },
      alive: this.alive().length,
    };
  }
}

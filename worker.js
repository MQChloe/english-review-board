// 英语复习看板 · 后端（按账号隔离）
// 学习进度存 Cloudflare Durable Object（SQLite，强一致、即时读写），每个账号一个独立实例。
// 文章正文仍由 GitHub Pages 的 data.json 提供；前端按 item id 合并进度。
const IV = [1, 3, 7, 14, 30];

function addDays(s, n) {
  const d = new Date(s + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() },
  });
}
function defaultReview() {
  return { reviews: 0, lapses: 0, level: 0, strength: "weak", last: null, nextDue: null, history: [] };
}
// 与前端一致的间隔重复算法
function applyVerdict(r, verdict, today) {
  r.reviews = (r.reviews || 0) + 1;
  r.last = today;
  r.history = r.history || [];
  r.history.push({ date: today, verdict });
  if (verdict === "remember") {
    r.lapses = 0;
    r.level = Math.min((r.level || 0) + 1, IV.length - 1);
    r.strength = r.level >= 3 ? "strong" : r.level >= 1 ? "learning" : "weak";
    r.nextDue = addDays(today, IV[r.level]);
  } else if (verdict === "fuzzy") {
    r.lapses = (r.lapses || 0) + 1;
    r.level = Math.max((r.level || 0) - 1, 0);
    r.strength = "learning";
    r.nextDue = addDays(today, 2);
  } else if (verdict === "forget") {
    r.lapses = (r.lapses || 0) + 1;
    r.level = 0;
    r.strength = "weak";
    r.nextDue = addDays(today, 1);
  }
  return r;
}

export class Progress {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async init() {
    this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS reviews (
      item_id  TEXT PRIMARY KEY,
      reviews  INTEGER,
      lapses   INTEGER,
      level    INTEGER,
      strength TEXT,
      last     TEXT,
      next_due TEXT,
      history  TEXT
    )`);
    this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (
      k TEXT PRIMARY KEY,
      v TEXT
    )`);
  }
  async getMeta(k) {
    const rows = this.state.storage.sql.exec("SELECT v FROM meta WHERE k = ?", k).toArray();
    return rows.length ? rows[0].v : null;
  }
  async setMeta(k, v) {
    this.state.storage.sql.exec(
      "INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
      k, v
    );
  }
  async getAll() {
    const rows = this.state.storage.sql
      .exec(`SELECT item_id,reviews,lapses,level,strength,last,next_due,history FROM reviews`)
      .toArray();
    const map = {};
    for (const r of rows) {
      map[r.item_id] = {
        reviews: r.reviews, lapses: r.lapses, level: r.level,
        strength: r.strength, last: r.last, nextDue: r.next_due,
        history: JSON.parse(r.history || "[]"),
      };
    }
    return map;
  }
  async upsert(r) {
    this.state.storage.sql.exec(
      `INSERT INTO reviews (item_id,reviews,lapses,level,strength,last,next_due,history)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET
         reviews=excluded.reviews, lapses=excluded.lapses, level=excluded.level,
         strength=excluded.strength, last=excluded.last, next_due=excluded.next_due,
         history=excluded.history`,
      r.item_id, r.reviews, r.lapses, r.level, r.strength, r.last, r.nextDue,
      JSON.stringify(r.history || [])
    );
  }
  async fetch(request) {
    await this.init();
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/health") return json({ ok: true, ts: Date.now() });

    // 登录 / 注册：首次设置密码哈希，之后校验。password 由前端做 hashPW 后传入。
    if (url.pathname === "/login") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      const acct = (body.account || "").toString().trim();
      const pw = body.password == null ? "" : body.password.toString();
      if (!acct || acct.length > 80) return json({ error: "bad account" }, 400);
      const stored = await this.getMeta("pw");
      if (!stored) { return json({ ok: false, error: "no account" }, 403); }  // 注册已关闭：仅允许已存在的账号登录
      if (stored === pw) return json({ ok: true });
      return json({ ok: false, error: "bad password" }, 401);
    }

    if (url.pathname === "/progress") {
      if (request.method !== "GET") return json({ error: "method" }, 405);
      return json({ account: url.searchParams.get("account") || "default", progress: await this.getAll(), ts: Date.now() });
    }

    if (url.pathname === "/feedback") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!body || body.secret !== this.env.SHARED_SECRET) return json({ error: "unauthorized" }, 401);

      const today = body.today || "";
      const fb = Array.isArray(body.feedback) ? body.feedback : [];
      if (!today || !fb.length) return json({ ok: true, skipped: true, progress: {} });

      const existing = await this.getAll();
      const updated = {};
      for (const f of fb) {
        if (!f || !f.id) continue;
        const r = existing[f.id] ? { ...existing[f.id] } : defaultReview();
        r.item_id = f.id;
        applyVerdict(r, f.verdict, today);
        await this.upsert(r);
        updated[f.id] = r;
      }
      return json({ ok: true, updated: Object.keys(updated).length, progress: updated });
    }

    if (url.pathname === "/import") {
      if (request.method !== "POST") return json({ error: "method" }, 405);
      let body;
      try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
      if (!body || body.secret !== this.env.SHARED_SECRET) return json({ error: "unauthorized" }, 401);
      const progress = (body.progress && typeof body.progress === "object") ? body.progress : {};
      let n = 0;
      for (const [id, rev] of Object.entries(progress)) {
        if (!rev) continue;
        const r = {
          item_id: id,
          reviews: rev.reviews || 0,
          lapses: rev.lapses || 0,
          level: rev.level || 0,
          strength: rev.strength || "weak",
          last: rev.last || null,
          nextDue: rev.nextDue || null,
          history: rev.history || [],
        };
        await this.upsert(r);
        n++;
      }
      return json({ ok: true, imported: n });
    }

    return json({ error: "not found" }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/health") return json({ ok: true, ts: Date.now() });

    // 账号隔离：从 query 或 POST body 取 account，每个账号一个 DO 实例
    let account = url.searchParams.get("account");
    if (!account && request.method === "POST") {
      try { const b = await request.clone().json(); account = b.account; } catch (e) {}
    }
    account = (account || "default").toString().trim() || "default";
    if (account.length > 80) return json({ error: "bad account" }, 400);

    const id = env.PROGRESS.idFromName(account);
    const stub = env.PROGRESS.get(id);
    return stub.fetch(request);
  },
};

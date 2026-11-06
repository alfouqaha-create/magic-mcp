const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { parseWorkbook } = require("./lib/parser");
const { buildCourse } = require("./lib/scheme");
const { nameMatches, hashPassword, verifyPassword } = require("./lib/auth");

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sections (
     id SERIAL PRIMARY KEY,
     code TEXT NOT NULL,
     section TEXT NOT NULL,
     teacher TEXT,
     semester TEXT,
     scheme JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (code, section)
   )`,
  `CREATE TABLE IF NOT EXISTS grades (
     section_id INTEGER NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
     academic_id TEXT NOT NULL,
     name TEXT NOT NULL,
     marks JSONB NOT NULL,
     PRIMARY KEY (section_id, academic_id)
   )`,
  `CREATE INDEX IF NOT EXISTS grades_academic_idx ON grades (academic_id)`,
  `CREATE TABLE IF NOT EXISTS accounts (
     academic_id TEXT PRIMARY KEY,
     pass_hash TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

async function ensureSchema(pool) {
  for (const sql of SCHEMA) await pool.query(sql);
}

// يحوّل الأرقام العربية/الفارسية إلى لاتينية
function normalizeDigits(s) {
  return String(s ?? "")
    .replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x0660)
    .replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x06f0)
    .trim();
}

// محدّد معدل بسيط في الذاكرة (لكل عنوان IP)
function makeLimiter(max, windowMs) {
  const hits = new Map();
  const entry = (ip) => {
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || e.reset < now) {
      e = { count: 0, reset: now + windowMs };
      hits.set(ip, e);
    }
    return e;
  };
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return {
    blocked: (ip) => entry(ip).count >= max,
    hit: (ip) => { entry(ip).count++; },
  };
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();

function createApp({ pool, adminPassword = "" }) {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
    next();
  });

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => {
      console.error(err);
      res.status(500).json({ error: "خطأ في الخادم" });
    });

  // ---------- واجهة الطالب ----------
  // تُحسب المحاولات الفاشلة فقط، حتى لا يُحجب صف كامل يفتح من شبكة المدرسة نفسها:
  // لكل عنوان IP: 30 محاولة فاشلة كل 10 دقائق، ولكل رقم أكاديمي: 8 محاولات فاشلة كل 15 دقيقة
  const ipMisses = makeLimiter(30, 10 * 60 * 1000);
  const idMisses = makeLimiter(8, 15 * 60 * 1000);
  const json = express.json({ limit: "2kb" });
  const MIN_PW = 6, MAX_PW = 72;

  const readId = (req) => {
    const id = normalizeDigits(req.body && req.body.academic_id);
    return /^\d{4,12}$/.test(id) ? id : null;
  };
  const tooMany = (res) =>
    res.status(429).json({ error: "محاولات خاطئة كثيرة، حاول بعد عدة دقائق" });

  async function loadCourses(id) {
    const { rows } = await pool.query(
      `SELECT s.id, s.code, s.section, s.teacher, s.semester, s.scheme, g.name, g.marks
         FROM grades g JOIN sections s ON s.id = g.section_id
        WHERE g.academic_id = $1
        ORDER BY s.code, s.section`,
      [id]
    );
    return rows;
  }
  const payload = (id, rows) => ({
    academic_id: id,
    name: rows[0].name,
    courses: rows.map((r) => buildCourse(r, r.marks)),
  });

  // إنشاء حساب لأول مرة: الرقم الأكاديمي + الاسم (للتحقق) + كلمة سر يختارها الطالب
  app.post("/api/student/register", json, wrap(async (req, res) => {
    if (ipMisses.blocked(req.ip)) return tooMany(res);
    const id = readId(req);
    const name = String((req.body && req.body.name) || "");
    const password = String((req.body && req.body.password) || "");
    if (!id) return res.status(400).json({ error: "أدخل رقمك الأكاديمي (أرقام فقط)" });
    if (password.length < MIN_PW || password.length > MAX_PW) {
      return res.status(400).json({ error: `كلمة السر يجب أن تكون من ${MIN_PW} إلى ${MAX_PW} حرفاً` });
    }
    if (password === id) {
      return res.status(400).json({ error: "لا تستخدم رقمك الأكاديمي ككلمة سر" });
    }
    if (idMisses.blocked(id)) return tooMany(res);

    const rows = await loadCourses(id);
    if (!rows.length || !rows.some((r) => nameMatches(name, r.name))) {
      ipMisses.hit(req.ip);
      idMisses.hit(id);
      return res.status(401).json({
        error: "البيانات غير مطابقة. تأكد من الرقم الأكاديمي ومن كتابة اسمك الثلاثي كما في كشف الدرجات",
      });
    }
    const taken = {
      error: "هذا الحساب مفعّل من قبل. سجّل الدخول، أو اطلب من المعلم إعادة تعيين كلمة السر",
    };
    const exists = await pool.query("SELECT 1 FROM accounts WHERE academic_id = $1", [id]);
    if (exists.rows.length) return res.status(409).json(taken);
    const pass_hash = await hashPassword(password);
    const ins = await pool.query(
      "INSERT INTO accounts (academic_id, pass_hash) VALUES ($1, $2) ON CONFLICT (academic_id) DO NOTHING RETURNING academic_id",
      [id, pass_hash]
    );
    if (!ins.rows.length) return res.status(409).json(taken); // سباق: سُجّل في اللحظة نفسها
    res.status(201).json(payload(id, rows));
  }));

  // الدخول: الرقم الأكاديمي + كلمة السر
  app.post("/api/student/login", json, wrap(async (req, res) => {
    if (ipMisses.blocked(req.ip)) return tooMany(res);
    const id = readId(req);
    const password = String((req.body && req.body.password) || "");
    if (!id) return res.status(400).json({ error: "أدخل رقمك الأكاديمي (أرقام فقط)" });
    if (idMisses.blocked(id)) return tooMany(res);

    const acc = await pool.query("SELECT pass_hash FROM accounts WHERE academic_id = $1", [id]);
    const stored = acc.rows.length ? acc.rows[0].pass_hash : null;
    const ok = await verifyPassword(password, stored); // يُنفَّذ حتى لو لا يوجد حساب لتساوي الأزمنة
    if (!ok) {
      ipMisses.hit(req.ip);
      idMisses.hit(id);
      return res.status(401).json({
        error: "الرقم الأكاديمي أو كلمة السر غير صحيحة. وإن لم تنشئ حساباً بعد فاختر «حساب جديد»",
      });
    }
    const rows = await loadCourses(id);
    if (!rows.length) return res.status(404).json({ error: "لا توجد درجات لهذا الرقم" });
    res.json(payload(id, rows));
  }));

  // ---------- واجهة المعلم ----------
  const adminFails = makeLimiter(10, 10 * 60 * 1000);

  function adminAuth(req, res, next) {
    if (!adminPassword) {
      return res.status(503).json({ error: "لم يتم ضبط ADMIN_PASSWORD على الخادم" });
    }
    if (adminFails.blocked(req.ip)) {
      return res.status(429).json({ error: "محاولات خاطئة كثيرة، حاول بعد عدة دقائق" });
    }
    const given = req.get("x-admin-password") || "";
    if (crypto.timingSafeEqual(sha(given), sha(adminPassword))) return next();
    adminFails.hit(req.ip);
    res.status(401).json({ error: "كلمة المرور غير صحيحة" });
  }

  app.get("/api/admin/sections", adminAuth, wrap(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT s.id, s.code, s.section, s.teacher, s.semester, s.updated_at,
              COUNT(g.academic_id) AS students
         FROM sections s LEFT JOIN grades g ON g.section_id = s.id
        GROUP BY s.id, s.code, s.section, s.teacher, s.semester, s.updated_at
        ORDER BY s.code, s.section`
    );
    res.json(rows.map((r) => ({ ...r, students: Number(r.students) })));
  }));

  app.get("/api/admin/sections/:id", adminAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "رقم غير صالح" });
    const s = await pool.query("SELECT * FROM sections WHERE id = $1", [id]);
    if (!s.rows.length) return res.status(404).json({ error: "الشعبة غير موجودة" });
    const g = await pool.query(
      "SELECT academic_id, name, marks FROM grades WHERE section_id = $1 ORDER BY academic_id",
      [id]
    );
    const reg = new Set((await pool.query("SELECT academic_id FROM accounts")).rows.map((a) => a.academic_id));
    res.json({
      section: { id, code: s.rows[0].code, section: s.rows[0].section },
      students: g.rows.map((r) => {
        const c = buildCourse(s.rows[0], r.marks);
        return {
          academic_id: r.academic_id,
          name: r.name,
          registered: reg.has(r.academic_id),
          groups: c.groups.map((x) => x.total),
          total: c.total,
          formative: c.formative,
          final: c.final,
        };
      }),
    });
  }));

  // رفع ملف Excel واحد لكل طلب (جسم الطلب هو الملف نفسه)
  app.post("/api/admin/import", adminAuth,
    express.raw({ type: () => true, limit: "8mb" }),
    wrap(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) {
        return res.status(400).json({ error: "لم يصل ملف" });
      }
      let parsed;
      try {
        parsed = await parseWorkbook(req.body);
      } catch (e) {
        return res.status(422).json({ error: "تعذر قراءة الملف: " + e.message });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const up = await client.query(
          `INSERT INTO sections (code, section, teacher, semester, scheme)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (code, section)
           DO UPDATE SET teacher = EXCLUDED.teacher, semester = EXCLUDED.semester,
                         scheme = EXCLUDED.scheme, updated_at = now()
           RETURNING id`,
          [parsed.code, parsed.section, parsed.teacher, parsed.semester, JSON.stringify(parsed.scheme)]
        );
        const sid = up.rows[0].id;
        await client.query("DELETE FROM grades WHERE section_id = $1", [sid]);
        for (const s of parsed.students) {
          await client.query(
            "INSERT INTO grades (section_id, academic_id, name, marks) VALUES ($1, $2, $3, $4)",
            [sid, s.academic_id, s.name, JSON.stringify(s.marks)]
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      res.json({
        code: parsed.code,
        section: parsed.section,
        count: parsed.students.length,
        warnings: parsed.warnings,
      });
    }));

  app.delete("/api/admin/sections/:id", adminAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "رقم غير صالح" });
    await pool.query("DELETE FROM sections WHERE id = $1", [id]);
    res.json({ ok: true });
  }));

  // إعادة تعيين حساب طالب (يحذف كلمة السر ليُنشئ الطالب حساباً جديداً)
  app.delete("/api/admin/accounts/:academic_id", adminAuth, wrap(async (req, res) => {
    const id = normalizeDigits(req.params.academic_id);
    if (!/^\d{4,12}$/.test(id)) return res.status(400).json({ error: "رقم غير صالح" });
    const r = await pool.query("DELETE FROM accounts WHERE academic_id = $1 RETURNING academic_id", [id]);
    res.json({ ok: true, deleted: r.rows.length });
  }));

  // ---------- الملفات الثابتة ----------
  app.get("/teacher", (req, res) =>
    res.sendFile(path.join(__dirname, "public", "teacher.html")));
  app.use(express.static(path.join(__dirname, "public")));

  return app;
}

async function start() {
  if (!process.env.DATABASE_URL) {
    console.error("خطأ: المتغير DATABASE_URL غير موجود. ضع رابط قاعدة Neon فيه.");
    process.exit(1);
  }
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await ensureSchema(pool);
  const adminPassword = process.env.ADMIN_PASSWORD || "";
  if (!adminPassword) console.warn("تنبيه: ADMIN_PASSWORD غير مضبوط، صفحة المعلم معطّلة.");
  const port = process.env.PORT || 3000;
  createApp({ pool, adminPassword }).listen(port, () => console.log("الخادم يعمل على المنفذ " + port));
}

module.exports = { createApp, ensureSchema };

if (require.main === module) {
  start().catch((err) => {
    console.error("تعذر تشغيل الخادم:", err.message);
    process.exit(1);
  });
}

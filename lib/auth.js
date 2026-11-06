const crypto = require("crypto");
const { promisify } = require("util");

const scrypt = promisify(crypto.scrypt);

// ---------- تطبيع الأسماء العربية ----------
// يزيل التشكيل والتطويل، ويوحّد (أإآ→ا) و(ى→ي) و(ة→ه) و(ؤ→و) و(ئ→ي)، ويتجاهل المسافات والرموز
function normalizeToken(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

const tokens = (s) =>
  String(s ?? "").trim().split(/\s+/).map(normalizeToken).filter(Boolean);

// يقبل الاسم المكتوب إذا كان:
//  أ) بداية اسم الطالب في الكشف (الأول + الأب + الجد ...)، أو
//  ب) يبدأ بالاسم الأول واسم الأب وينتهي باسم العائلة (مثل: الأول + الأب + العائلة)
// بحد أدنى 8 أحرف حتى لا يكفي الاسم الأول وحده
function nameMatches(typed, full) {
  const t = normalizeToken(typed);
  const fTokens = tokens(full);
  const f = fTokens.join("");
  if (t.length < 8 || !f) return false;
  if (f.startsWith(t)) return true;
  // الصيغة المختصرة: الأول + الأب + العائلة (اسم الأب إلزامي)
  if (fTokens.length < 3) return false;
  return t.startsWith(fTokens[0] + fTokens[1]) && t.endsWith(fTokens[fTokens.length - 1]);
}

// ---------- كلمات السر ----------
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(String(password).normalize("NFKC"), salt, 32);
  return `s1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

// حساب وهمي يُستخدم حين لا يوجد حساب، حتى لا يختلف زمن الرد
const DUMMY = `s1$${"00".repeat(16)}$${"00".repeat(32)}`;

async function verifyPassword(password, stored) {
  const parts = String(stored || DUMMY).split("$");
  if (parts.length !== 3 || parts[0] !== "s1") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = await scrypt(String(password).normalize("NFKC"), salt, expected.length);
  return crypto.timingSafeEqual(actual, expected) && stored !== undefined && stored !== null;
}

module.exports = { normalizeToken, nameMatches, hashPassword, verifyPassword };

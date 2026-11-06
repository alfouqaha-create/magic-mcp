const ExcelJS = require("exceljs");
const { FIELDS } = require("./scheme");

function cellValue(cell) {
  let v = cell.value;
  if (v && typeof v === "object") {
    if ("result" in v) v = v.result;
    else if (Array.isArray(v.richText)) v = v.richText.map((r) => r.text).join("");
    else if (v instanceof Date) v = null;
    else v = null;
  }
  return v === undefined ? null : v;
}

const text = (v) => (v == null ? "" : String(v).trim());

// يقرأ ملف "الكشف التجميعي" لشعبة واحدة ويرجع بياناتها
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet("الكشف التجميعي") || wb.worksheets[0];
  if (!ws) throw new Error("الملف لا يحتوي على أوراق");

  const get = (r, c) => cellValue(ws.getCell(r, c));

  // تحقق من أن الملف بنفس النموذج المتوقع
  if (!text(get(3, 2)).includes("الرقم الأكاديمي") || !text(get(3, 3)).includes("اسم الطالب")) {
    throw new Error("هيكل الملف غير مطابق للنموذج (استمارة التقويم التكويني)");
  }

  const title = text(get(1, 1));
  const section = (title.match(/للشعبة\s+(.+?)\s+للفصل/) || [])[1];
  const sm = title.match(/للفصل\s+(.+)$/); // "للفصل" = ل + "الفصل"
  const semester = sm ? "الفصل " + sm[1] : "";
  if (!section) throw new Error("تعذر قراءة اسم الشعبة من عنوان الملف");

  // اسم المعلم ورمز المقرر من الصف الثاني (القيمة هي أول خلية غير فارغة بعد العنوان)
  const labelValue = (label) => {
    for (let c = 1; c <= 19; c++) {
      if (text(get(2, c)) === label) {
        // الخلايا المدمجة تكرّر قيمة العنوان، فنتخطاها حتى أول قيمة مختلفة
        for (let k = c + 1; k <= 19; k++) {
          const t = text(get(2, k));
          if (t && t !== label) return t;
        }
      }
    }
    return "";
  };
  const teacher = labelValue("اسم المعلم");
  const code = labelValue("رمز المقرر");
  if (!code) throw new Error("تعذر قراءة رمز المقرر");

  // الدرجات العظمى من الصف السادس
  const fields = {};
  for (const f of FIELDS) {
    const m = get(6, f.col);
    if (typeof m !== "number" || m <= 0) throw new Error("تعذر قراءة الدرجة العظمى لـ " + f.label);
    fields[f.key] = m;
  }

  const warnings = [];
  const seen = new Set();
  const students = [];
  for (let r = 7; r <= ws.rowCount; r++) {
    if (typeof get(r, 1) !== "number") continue;
    const id = text(get(r, 2));
    if (!/^\d{4,12}$/.test(id)) continue;
    if (seen.has(id)) {
      warnings.push(`رقم أكاديمي مكرر (${id}) تم تجاهله`);
      continue;
    }
    seen.add(id);
    let name = text(get(r, 3));
    if (!name) {
      name = "طالب " + id;
      warnings.push(`الرقم ${id}: الاسم فارغ في الملف`);
    }
    const marks = {};
    for (const f of FIELDS) {
      const v = get(r, f.col);
      marks[f.key] = typeof v === "number" ? v : null;
      if (typeof v === "number" && (v < 0 || v > fields[f.key])) {
        warnings.push(`${name}: ${f.label} = ${v} خارج الحد (${fields[f.key]})`);
      }
    }
    students.push({ academic_id: id, name, marks });
  }
  if (!students.length) throw new Error("لم يُعثر على أي طالب في الملف");

  return { code, section, teacher, semester, scheme: { fields }, students, warnings };
}

module.exports = { parseWorkbook };

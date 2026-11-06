// سلّم التقييم المشترك بين كل الشعب (مأخوذ من نموذج "استمارة التقويم التكويني")
// col = رقم العمود في ملف Excel (يبدأ من 1)
const FIELDS = [
  { key: "obs_behavior",   label: "سلوك الطالب",             col: 4 },
  { key: "obs_academic",   label: "الأداء الأكاديمي",        col: 5 },
  { key: "file_org",       label: "الإجراءات التنظيمية",     col: 7 },
  { key: "file_improve",   label: "تحسين التعلم",            col: 8 },
  { key: "file_init",      label: "المبادرات",               col: 9 },
  { key: "task_project",   label: "المشروع",                 col: 11 },
  { key: "task_show",      label: "العرض",                   col: 12 },
  { key: "test1",          label: "اختبار 1",                col: 14 },
  { key: "test2",          label: "اختبار 2",                col: 15 },
  { key: "final_practical", label: "الامتحان النهائي (العملي)", col: 19 },
];

const GROUPS = [
  { label: "الملاحظة الصفية", items: ["obs_behavior", "obs_academic"] },
  { label: "ملف الطالب",      items: ["file_org", "file_improve", "file_init"] },
  { label: "المهام",          items: ["task_project", "task_show"] },
  { label: "الاختبارات",      items: ["test1", "test2"] },
];

const LABELS = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));
const FORMATIVE_MAX = 40;

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
// نفس صيغة Excel: MROUND(المجموع/2.5, 0.5)
const roundHalf = (x) => Math.round(x * 2) / 2;

function buildCourse(section, marks) {
  const max = section.scheme.fields;
  const groups = GROUPS.map((g) => {
    const items = g.items.map((key) => ({
      key,
      label: LABELS[key],
      max: max[key],
      value: num(marks[key]),
    }));
    return {
      label: g.label,
      max: sum(items.map((i) => i.max)),
      total: sum(items.map((i) => i.value ?? 0)),
      items,
    };
  });
  const total = sum(groups.map((g) => g.total));
  const totalMax = sum(groups.map((g) => g.max));
  const formative = roundHalf(total / (totalMax / FORMATIVE_MAX));
  return {
    code: section.code,
    section: section.section,
    teacher: section.teacher,
    semester: section.semester,
    groups,
    total,
    totalMax,
    formative,
    formativeMax: FORMATIVE_MAX,
    final: num(marks.final_practical),
    finalMax: max.final_practical,
  };
}

module.exports = { FIELDS, GROUPS, LABELS, buildCourse };

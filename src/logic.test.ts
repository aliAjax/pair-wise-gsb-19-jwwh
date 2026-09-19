import {
  detectAnomalies,
  estimateAfterWaterChange,
  correctionConflicts,
  estimateDriftConflicts,
  validateChain,
  TestRecord,
  AppState,
} from "./water";

const assert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error("FAIL: " + msg);
  console.log("ok -", msg);
};

// 1. 阈值规则
assert(detectAnomalies({ ph: 5.9, ammonia: 0.1, nitrate: 10, temperature: 25 }).some((a) => a.rule === "pH < 6"), "pH<6 触发");
assert(detectAnomalies({ ph: 8.6, ammonia: 0.1, nitrate: 10, temperature: 25 }).some((a) => a.rule === "pH > 8.5"), "pH>8.5 触发");
assert(detectAnomalies({ ph: 7, ammonia: 0.21, nitrate: 10, temperature: 25 }).some((a) => a.rule === "氨氮 > 0.2mg/L"), "氨氮>0.2 触发");
assert(detectAnomalies({ ph: 7, ammonia: 0.2, nitrate: 40, temperature: 30 }).length === 0, "边界值不触发");
assert(detectAnomalies({ ph: 7, ammonia: 0.1, nitrate: 41, temperature: 25 }).some((a) => a.rule === "硝酸盐 > 40mg/L"), "硝酸盐>40 触发");
assert(detectAnomalies({ ph: 7, ammonia: 0.1, nitrate: 10, temperature: 21.9 }).some((a) => a.rule === "温度 < 22℃"), "温度<22 触发");
assert(detectAnomalies({ ph: 7, ammonia: 0.1, nitrate: 10, temperature: 30.1 }).some((a) => a.rule === "温度 > 30℃"), "温度>30 触发");

// 2. 换水按比例回填
const est = estimateAfterWaterChange({ ph: 6.5, ammonia: 0.3, nitrate: 40, temperature: 26 }, 30);
assert(est.ammonia === 0.21, `氨氮 0.3→0.21 (实际 ${est.ammonia})`);
assert(est.nitrate === 28, `硝酸盐 40→28 (实际 ${est.nitrate})`);
assert(est.ph === 6.65, `pH 向 7 回归 6.5→6.65 (实际 ${est.ph})`);
assert(est.temperature === 26, "温度不随换水变化");

// 3. 修正版本冲突：列出指标/原值/新值/触发规则
const rec = (id: string, v: number, values: any, supersedes: string | null, reason: string | null): TestRecord => ({
  id, groupId: "g1", version: v, supersedes, correctionReason: reason,
  tankId: "t1", measuredAt: "2026-09-19T08:00:00.000Z", values, waterChangePct: 0,
  anomalies: detectAnomalies(values), createdAt: "2026-09-19T09:00:00.000Z",
});
const v1 = rec("r1", 1, { ph: 7.2, ammonia: 0.18, nitrate: 45, temperature: 23 }, null, null);
const v2 = rec("r2", 2, { ph: 7.2, ammonia: 0.18, nitrate: 38, temperature: 23 }, "r1", "复测修正");
const cf = correctionConflicts("t1", v1, v2, "2026-09-19T09:00:00.000Z");
assert(cf.length === 1 && cf[0].metric === "硝酸盐" && cf[0].oldValue === "45 mg/L" && cf[0].newValue === "38 mg/L", "修正冲突列出原值/新值");
assert(cf[0].rule.includes("已恢复正常"), "修正冲突含触发规则");

// 4. 估算 vs 实测偏差冲突
const drift = estimateDriftConflicts("t1", { ph: 7, ammonia: 0.1, nitrate: 20, temperature: 25 }, { ph: 7, ammonia: 0.2, nitrate: 20, temperature: 25 }, "2026-09-19T09:00:00.000Z");
assert(drift.length === 1 && drift[0].metric === "氨氮", "估算偏差>10% 触发冲突");

// 5. 数据链校验：完整状态无冲突，断链有冲突
const good: AppState = {
  tanks: [{ id: "t1", name: "A", kind: "草缸", volumeL: 100, createdAt: "x" }],
  records: [v1, v2],
  treatments: [{ id: "tr1", tankId: "t1", recordId: "r1", metric: "nitrate", rule: "硝酸盐 > 40mg/L", value: 45, action: "换水", status: "closed", createdAt: "x", closedAt: "y", closeNote: "n" }],
  waterChanges: [],
  conflicts: [],
  savedAt: null,
};
assert(validateChain(good, "now").length === 0, "完整链校验通过");
const broken: AppState = { ...good, records: [v2] };
assert(validateChain(broken, "now").length >= 2, "断链（缺 v1 与处置指向）被检出");

console.log("\n全部断言通过");

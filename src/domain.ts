// 领域模型与规则：鱼缸、检测记录（版本链）、异常处置、换水回填、冲突检测

export type MetricKey = "ph" | "ammonia" | "nitrate" | "temperature";

export interface MetricValues {
  ph: number;
  ammonia: number;
  nitrate: number;
  temperature: number;
}

export interface RuleDef {
  metric: MetricKey;
  label: string;
  unit: string;
  decimals: number;
  test: (v: number) => boolean;
  describe: string;
}

// 异常触发规则（保存前必须登记处置动作的判定条件）
export const RULES: RuleDef[] = [
  { metric: "ph", label: "pH", unit: "", decimals: 2, test: (v) => v < 6 || v > 8.5, describe: "pH 低于 6 或高于 8.5" },
  { metric: "ammonia", label: "氨氮", unit: "mg/L", decimals: 3, test: (v) => v > 0.2, describe: "氨氮高于 0.2mg/L" },
  { metric: "nitrate", label: "硝酸盐", unit: "mg/L", decimals: 1, test: (v) => v > 40, describe: "硝酸盐高于 40mg/L" },
  { metric: "temperature", label: "温度", unit: "℃", decimals: 1, test: (v) => v < 22 || v > 30, describe: "温度低于 22℃ 或高于 30℃" },
];

export const RULE_BY_METRIC: Record<MetricKey, RuleDef> = Object.fromEntries(
  RULES.map((r) => [r.metric, r])
) as Record<MetricKey, RuleDef>;

export const METRIC_ORDER: MetricKey[] = ["ph", "ammonia", "nitrate", "temperature"];

// 换水回填模型假设：补水 pH 7.0、25℃、氨氮/硝酸盐为 0，按换水量比例混合
export const REFILL_WATER: MetricValues = { ph: 7.0, ammonia: 0, nitrate: 0, temperature: 25 };

export interface DisposalAction {
  id: string;
  text: string;
  createdAt: string;
}

export interface Anomaly {
  id: string;
  metric: MetricKey;
  rule: string; // 触发规则快照
  value: number; // 触发时的检测值
  status: "open" | "closed";
  disposals: DisposalAction[];
  createdAt: string;
  closedAt?: string;
}

export interface Measurement extends MetricValues {
  id: string;
  tankId: string;
  kind: "manual" | "estimate"; // 手动检测 / 换水回填估算
  measuredAt: string; // 检测时间
  version: number;
  supersedes: string | null; // 被修正时指向上一版本 id
  reason: string | null; // 修正原因 / 回填说明
  anomalies: Anomaly[];
  createdAt: string;
}

export interface WaterChange {
  id: string;
  tankId: string;
  percent: number; // 换水量比例 %
  status: "planned" | "completed";
  createdAt: string;
  completedAt?: string;
  sourceRecordId?: string; // 回填基准检测记录
  estimateRecordId?: string; // 完成时生成的估算记录
}

export interface Tank {
  id: string;
  name: string;
  type: string;
  volumeL: number;
  createdAt: string;
}

export interface AppState {
  tanks: Tank[];
  records: Measurement[];
  waterChanges: WaterChange[];
}

export interface Conflict {
  tank: string;
  metric: string;
  oldValue: string;
  newValue: string;
  rule: string;
}

export function uid(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

export function roundTo(v: number, decimals: number): number {
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
}

export function fmtMetric(metric: MetricKey, value: number): string {
  const rule = RULE_BY_METRIC[metric];
  return `${value.toFixed(rule.decimals)}${rule.unit}`;
}

// 评估一组检测值触发了哪些规则
export function evaluateValues(values: MetricValues): { rule: RuleDef; value: number }[] {
  return RULES.filter((r) => r.test(values[r.metric])).map((rule) => ({
    rule,
    value: values[rule.metric],
  }));
}

// 换水完成后的估算浓度：按换水量比例与补水混合
export function computeEstimate(src: MetricValues, percent: number): MetricValues {
  const r = percent / 100;
  return {
    ph: roundTo(src.ph + (REFILL_WATER.ph - src.ph) * r, RULE_BY_METRIC.ph.decimals),
    ammonia: roundTo(src.ammonia * (1 - r), RULE_BY_METRIC.ammonia.decimals),
    nitrate: roundTo(src.nitrate * (1 - r), RULE_BY_METRIC.nitrate.decimals),
    temperature: roundTo(src.temperature + (REFILL_WATER.temperature - src.temperature) * r, RULE_BY_METRIC.temperature.decimals),
  };
}

function supersededIds(state: AppState): Set<string> {
  return new Set(state.records.filter((r) => r.supersedes).map((r) => r.supersedes as string));
}

// 鱼缸当前有效（未被修正替代）的检测记录，新→旧
export function activeRecords(state: AppState, tankId: string): Measurement[] {
  const superseded = supersededIds(state);
  return state.records
    .filter((r) => r.tankId === tankId && !superseded.has(r.id))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// 未关闭异常（仅统计当前有效记录上的）
export function openAnomalies(state: AppState, tankId: string): { record: Measurement; anomaly: Anomaly }[] {
  return activeRecords(state, tankId).flatMap((record) =>
    record.anomalies.filter((a) => a.status === "open").map((anomaly) => ({ record, anomaly }))
  );
}

function latestInChain(state: AppState, rec: Measurement): Measurement {
  let cur = rec;
  for (;;) {
    const next = state.records.find((x) => x.supersedes === cur.id);
    if (!next) return cur;
    cur = next;
  }
}

// 全量一致性/冲突检查：刷新或导入后执行，输出 鱼缸/指标/原值/新值/触发规则
export function detectConflicts(state: AppState): Conflict[] {
  const conflicts: Conflict[] = [];
  const tankById = new Map(state.tanks.map((t) => [t.id, t]));
  const recordById = new Map(state.records.map((r) => [r.id, r]));

  // C5 链完整性：孤儿记录 / 孤儿换水
  for (const rec of state.records) {
    if (!tankById.has(rec.tankId)) {
      conflicts.push({ tank: rec.tankId, metric: "检测记录", oldValue: rec.id, newValue: "—", rule: "链完整性：记录所属鱼缸不存在" });
    }
  }
  for (const w of state.waterChanges) {
    if (!tankById.has(w.tankId)) {
      conflicts.push({ tank: w.tankId, metric: "换水记录", oldValue: w.id, newValue: "—", rule: "链完整性：换水所属鱼缸不存在" });
    }
  }

  for (const tank of state.tanks) {
    const tankRecords = state.records.filter((r) => r.tankId === tank.id);
    const superseded = supersededIds(state);

    // C1 处置依据失效：旧版本登记过处置的异常，修正后该指标已回到正常范围
    for (const rec of tankRecords) {
      if (!superseded.has(rec.id)) continue;
      const latest = latestInChain(state, rec);
      for (const an of rec.anomalies) {
        if (an.disposals.length === 0) continue;
        const rule = RULE_BY_METRIC[an.metric];
        const newVal = latest[an.metric];
        if (!rule.test(newVal)) {
          conflicts.push({
            tank: tank.name,
            metric: rule.label,
            oldValue: fmtMetric(an.metric, an.value),
            newValue: fmtMetric(an.metric, newVal),
            rule: `${an.rule}（已登记处置，修正后触发条件消失，处置依据失效）`,
          });
        }
      }
    }

    // C3 异常未处置：当前有效记录触发了规则但没有任何处置动作
    for (const rec of tankRecords) {
      if (superseded.has(rec.id)) continue;
      for (const an of rec.anomalies) {
        if (an.disposals.length === 0) {
          conflicts.push({
            tank: tank.name,
            metric: RULE_BY_METRIC[an.metric].label,
            oldValue: fmtMetric(an.metric, an.value),
            newValue: "未登记处置动作",
            rule: an.rule,
          });
        }
      }
    }

    // C2 回填失效：换水回填所依据的检测记录后来被修正，估算值与按新值重算的结果不一致
    for (const w of state.waterChanges) {
      if (w.tankId !== tank.id || w.status !== "completed" || !w.sourceRecordId || !w.estimateRecordId) continue;
      const src = recordById.get(w.sourceRecordId);
      const est = recordById.get(w.estimateRecordId);
      if (!src || !est) {
        conflicts.push({
          tank: tank.name,
          metric: "换水回填",
          oldValue: `换水 ${w.percent}%`,
          newValue: "回填链断裂",
          rule: "链完整性：回填基准或估算记录缺失",
        });
        continue;
      }
      const latest = latestInChain(state, src);
      if (latest.id === src.id) continue;
      const expected = computeEstimate(latest, w.percent);
      for (const m of METRIC_ORDER) {
        if (Math.abs(expected[m] - est[m]) > 1e-9) {
          conflicts.push({
            tank: tank.name,
            metric: RULE_BY_METRIC[m].label,
            oldValue: fmtMetric(m, est[m]),
            newValue: fmtMetric(m, expected[m]),
            rule: `换水 ${w.percent}% 回填基准已被 v${latest.version} 修正，估算浓度需重算`,
          });
        }
      }
    }

    // C4 带病换水：换水完成时该缸存在未关闭异常
    for (const w of state.waterChanges) {
      if (w.tankId !== tank.id || w.status !== "completed" || !w.completedAt) continue;
      for (const rec of tankRecords) {
        const next = state.records.find((x) => x.supersedes === rec.id);
        const recInactiveAt = next ? next.createdAt : null;
        for (const an of rec.anomalies) {
          const openedAt = rec.createdAt;
          const closedAt = an.closedAt ?? recInactiveAt;
          if (openedAt <= w.completedAt && (closedAt == null || closedAt > w.completedAt)) {
            conflicts.push({
              tank: tank.name,
              metric: RULE_BY_METRIC[an.metric].label,
              oldValue: fmtMetric(an.metric, an.value),
              newValue: `换水 ${w.percent}% 于 ${w.completedAt.slice(0, 16).replace("T", " ")}`,
              rule: "异常未关闭时禁止记录换水完成",
            });
          }
        }
      }
    }
  }

  return conflicts;
}

// 初始示例数据
export function seedState(): AppState {
  const now = Date.now();
  const iso = (hoursAgo: number) => new Date(now - hoursAgo * 3600_000).toISOString();
  const local = (hoursAgo: number) => iso(hoursAgo).slice(0, 16);

  const tanks: Tank[] = [
    { id: "tank-a", name: "草缸A", type: "草缸", volumeL: 200, createdAt: iso(24 * 30) },
    { id: "tank-b", name: "海缸B", type: "海缸", volumeL: 350, createdAt: iso(24 * 30) },
    { id: "tank-c", name: "繁殖缸C", type: "繁殖缸", volumeL: 80, createdAt: iso(24 * 20) },
  ];

  const records: Measurement[] = [
    {
      id: "rec-a1", tankId: "tank-a", kind: "manual", measuredAt: local(30),
      ph: 6.8, ammonia: 0.05, nitrate: 18, temperature: 25,
      version: 1, supersedes: null, reason: null, anomalies: [], createdAt: iso(30),
    },
    {
      id: "rec-b1", tankId: "tank-b", kind: "manual", measuredAt: local(26),
      ph: 8.1, ammonia: 0.02, nitrate: 12, temperature: 26,
      version: 1, supersedes: null, reason: null, anomalies: [], createdAt: iso(26),
    },
    {
      id: "rec-c1", tankId: "tank-c", kind: "manual", measuredAt: local(20),
      ph: 7.2, ammonia: 0.35, nitrate: 55, temperature: 24,
      version: 1, supersedes: null, reason: null, createdAt: iso(20),
      anomalies: [
        {
          id: "an-c1-nh3", metric: "ammonia", rule: "氨氮高于 0.2mg/L", value: 0.35, status: "open",
          disposals: [{ id: "dp-c1-1", text: "停止投喂，添加硝化细菌", createdAt: iso(20) }], createdAt: iso(20),
        },
        {
          id: "an-c1-no3", metric: "nitrate", rule: "硝酸盐高于 40mg/L", value: 55, status: "open",
          disposals: [{ id: "dp-c1-2", text: "每日复测，准备换水 40%", createdAt: iso(20) }], createdAt: iso(20),
        },
      ],
    },
  ];

  const waterChanges: WaterChange[] = [
    { id: "wc-a1", tankId: "tank-a", percent: 30, status: "planned", createdAt: iso(10) },
  ];

  return { tanks, records, waterChanges };
}

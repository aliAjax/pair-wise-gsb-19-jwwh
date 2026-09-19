// 领域模型与业务规则：阈值判定、换水回填、版本修正、冲突与数据链校验

export type MetricKey = "ph" | "ammonia" | "nitrate" | "temperature";

export interface MetricValues {
  ph: number;
  ammonia: number; // mg/L
  nitrate: number; // mg/L
  temperature: number; // ℃
}

export interface Tank {
  id: string;
  name: string;
  kind: string;
  volumeL: number;
  createdAt: string;
}

export interface Anomaly {
  metric: MetricKey;
  value: number;
  rule: string; // 触发的阈值规则文本
}

export interface TestRecord {
  id: string;
  groupId: string; // 同一修正链的分组（v1 的 id）
  version: number;
  supersedes: string | null; // 被取代版本的记录 id
  correctionReason: string | null; // 修正原因（v2+ 必填）
  tankId: string;
  measuredAt: string; // 检测时间
  values: MetricValues;
  waterChangePct: number; // 本次登记的换水量（%）
  anomalies: Anomaly[]; // 保存时的异常快照
  createdAt: string;
}

export interface Treatment {
  id: string;
  tankId: string;
  recordId: string; // 触发该处置的检测记录
  metric: MetricKey;
  rule: string;
  value: number;
  action: string; // 处置动作
  status: "open" | "closed";
  createdAt: string;
  closedAt: string | null;
  closeNote: string | null;
}

export interface WaterChange {
  id: string;
  tankId: string;
  recordId: string; // 登记换水的检测记录
  percent: number; // 换水量 %
  status: "planned" | "completed";
  createdAt: string;
  completedAt: string | null;
  estimate: MetricValues | null; // 完成后按比例回填的估算浓度
  baseRecordId: string | null; // 估算所依据的记录
}

export type ConflictKind = "correction" | "estimate-drift" | "chain";

export interface Conflict {
  id: string;
  kind: ConflictKind;
  tankId: string;
  metric: string; // 指标名或“数据链”
  oldValue: string;
  newValue: string;
  rule: string; // 触发规则
  createdAt: string;
}

export interface AppState {
  tanks: Tank[];
  records: TestRecord[];
  treatments: Treatment[];
  waterChanges: WaterChange[];
  conflicts: Conflict[];
  savedAt: string | null;
}

export const METRIC_ORDER: MetricKey[] = ["ph", "ammonia", "nitrate", "temperature"];

export const METRICS: Record<
  MetricKey,
  { label: string; unit: string; min?: number; max?: number; decimals: number }
> = {
  ph: { label: "pH", unit: "", min: 6, max: 8.5, decimals: 2 },
  ammonia: { label: "氨氮", unit: "mg/L", max: 0.2, decimals: 3 },
  nitrate: { label: "硝酸盐", unit: "mg/L", max: 40, decimals: 1 },
  temperature: { label: "温度", unit: "℃", min: 22, max: 30, decimals: 1 },
};

export function uid(prefix: string): string {
  const rand =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

export function roundTo(value: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

export function formatMetric(metric: MetricKey, value: number): string {
  const meta = METRICS[metric];
  const text = roundTo(value, meta.decimals).toFixed(meta.decimals).replace(/\.?0+$/, "");
  return meta.unit ? `${text} ${meta.unit}` : text;
}

/** 阈值规则：pH<6 或 >8.5；氨氮>0.2；硝酸盐>40；温度<22 或 >30 */
export function detectAnomalies(values: MetricValues): Anomaly[] {
  const out: Anomaly[] = [];
  for (const key of METRIC_ORDER) {
    const meta = METRICS[key];
    const value = values[key];
    if (meta.min !== undefined && value < meta.min) {
      out.push({ metric: key, value, rule: `${meta.label} < ${meta.min}${meta.unit}`.trim() });
    }
    if (meta.max !== undefined && value > meta.max) {
      out.push({ metric: key, value, rule: `${meta.label} > ${meta.max}${meta.unit}`.trim() });
    }
  }
  return out;
}

export function anomalyFor(values: MetricValues, metric: MetricKey): Anomaly | null {
  return detectAnomalies(values).find((a) => a.metric === metric) ?? null;
}

/**
 * 换水完成后的估算回填：
 * - 氨氮 / 硝酸盐 按 (1 - 换水比例) 稀释
 * - pH 按换水比例向中性 7.0 回归
 * - 温度不由换水推算，保持原值
 */
export function estimateAfterWaterChange(base: MetricValues, percent: number): MetricValues {
  const ratio = Math.min(100, Math.max(0, percent)) / 100;
  return {
    ph: roundTo(base.ph + (7 - base.ph) * ratio, 2),
    ammonia: roundTo(base.ammonia * (1 - ratio), 3),
    nitrate: roundTo(base.nitrate * (1 - ratio), 1),
    temperature: roundTo(base.temperature, 1),
  };
}

// ---------- 派生状态 ----------

export function recordsOfTank(state: AppState, tankId: string): TestRecord[] {
  return state.records
    .filter((r) => r.tankId === tankId)
    .sort((a, b) => a.measuredAt.localeCompare(b.measuredAt) || a.version - b.version);
}

/** 每个修正链的最新版本 */
export function latestVersions(records: TestRecord[]): TestRecord[] {
  const byGroup = new Map<string, TestRecord>();
  for (const r of records) {
    const cur = byGroup.get(r.groupId);
    if (!cur || r.version > cur.version) byGroup.set(r.groupId, r);
  }
  return [...byGroup.values()];
}

export function latestRecord(state: AppState, tankId: string): TestRecord | null {
  const latest = latestVersions(recordsOfTank(state, tankId));
  if (latest.length === 0) return null;
  return latest.sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))[0];
}

export function openTreatments(state: AppState, tankId: string): Treatment[] {
  return state.treatments.filter((t) => t.tankId === tankId && t.status === "open");
}

export interface CurrentReading {
  values: MetricValues;
  source: "measured" | "estimate";
  at: string;
  baseRecord: TestRecord | null;
  waterChange: WaterChange | null;
}

/** 鱼缸当前读数：最近一次检测，或其后最近一次已完成换水的回填估算 */
export function currentReading(state: AppState, tankId: string): CurrentReading | null {
  const record = latestRecord(state, tankId);
  const completed = state.waterChanges
    .filter((w) => w.tankId === tankId && w.status === "completed" && w.estimate)
    .sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""));
  const lastChange = completed[0] ?? null;

  if (!record && !lastChange) return null;
  if (lastChange && (!record || (lastChange.completedAt ?? "") > record.measuredAt)) {
    return {
      values: lastChange.estimate!,
      source: "estimate",
      at: lastChange.completedAt!,
      baseRecord: state.records.find((r) => r.id === lastChange.baseRecordId) ?? null,
      waterChange: lastChange,
    };
  }
  return {
    values: record!.values,
    source: "measured",
    at: record!.measuredAt,
    baseRecord: record,
    waterChange: null,
  };
}

// ---------- 冲突 ----------

/** 修正版本与上一版本逐项对比，列出 指标 / 原值 / 新值 / 触发规则 */
export function correctionConflicts(
  tankId: string,
  prev: TestRecord,
  next: TestRecord,
  now: string
): Conflict[] {
  const out: Conflict[] = [];
  for (const metric of METRIC_ORDER) {
    const oldV = prev.values[metric];
    const newV = next.values[metric];
    if (oldV === newV) continue;
    const oldHit = anomalyFor(prev.values, metric);
    const newHit = anomalyFor(next.values, metric);
    let rule: string;
    if (oldHit && !newHit) rule = `${oldHit.rule} → 已恢复正常`;
    else if (!oldHit && newHit) rule = `新触发 ${newHit.rule}`;
    else if (oldHit && newHit) rule = `${oldHit.rule} → ${newHit.rule}（仍异常）`;
    else rule = "数值修正（未触发阈值）";
    out.push({
      id: uid("cf"),
      kind: "correction",
      tankId,
      metric: METRICS[metric].label,
      oldValue: formatMetric(metric, oldV),
      newValue: formatMetric(metric, newV),
      rule,
      createdAt: now,
    });
  }
  return out;
}

/** 换水回填估算 vs 下一次实测：相对偏差超过 10% 且超过最小绝对差即列为冲突 */
export function estimateDriftConflicts(
  tankId: string,
  estimate: MetricValues,
  measured: MetricValues,
  now: string
): Conflict[] {
  const eps: Record<MetricKey, number> = { ph: 0.2, ammonia: 0.02, nitrate: 2, temperature: 1 };
  const out: Conflict[] = [];
  for (const metric of METRIC_ORDER) {
    const est = estimate[metric];
    const act = measured[metric];
    const diff = Math.abs(est - act);
    const rel = Math.abs(est) > 1e-9 ? diff / Math.abs(est) : diff > 0 ? 1 : 0;
    if (diff > eps[metric] && rel > 0.1) {
      out.push({
        id: uid("cf"),
        kind: "estimate-drift",
        tankId,
        metric: METRICS[metric].label,
        oldValue: `${formatMetric(metric, est)}（估算）`,
        newValue: `${formatMetric(metric, act)}（实测）`,
        rule: "换水回填估算与实测偏差 > 10%",
        createdAt: now,
      });
    }
  }
  return out;
}

/** 刷新/载入后的数据链一致性校验：鱼缸—检测—处置—换水引用必须闭合 */
export function validateChain(state: AppState, now: string): Conflict[] {
  const out: Conflict[] = [];
  const tankIds = new Set(state.tanks.map((t) => t.id));
  const recordIds = new Set(state.records.map((r) => r.id));
  const push = (metric: string, oldValue: string, newValue: string, rule: string) =>
    out.push({ id: uid("cf"), kind: "chain", tankId: "", metric, oldValue, newValue, rule, createdAt: now });

  for (const r of state.records) {
    if (!tankIds.has(r.tankId)) push("数据链", `记录 ${r.id}`, `鱼缸 ${r.tankId}`, "检测记录指向不存在的鱼缸");
    if (r.supersedes && !recordIds.has(r.supersedes))
      push("数据链", `记录 ${r.id} v${r.version}`, `supersedes ${r.supersedes}`, "修正链指向不存在的上一版本");
    if (r.version > 1 && !r.correctionReason)
      push("数据链", `记录 ${r.id} v${r.version}`, "缺修正原因", "v2+ 版本必须携带修正原因");
    if (r.anomalies.length > 0) {
      const hasTreatment = state.treatments.some((t) => t.recordId === r.id);
      if (!hasTreatment) push("数据链", `记录 ${r.id}`, `${r.anomalies.length} 项异常`, "异常记录缺少处置动作");
    }
  }
  for (const t of state.treatments) {
    if (!recordIds.has(t.recordId)) push("数据链", `处置 ${t.id}`, `记录 ${t.recordId}`, "处置指向不存在的检测记录");
    if (!tankIds.has(t.tankId)) push("数据链", `处置 ${t.id}`, `鱼缸 ${t.tankId}`, "处置指向不存在的鱼缸");
  }
  for (const w of state.waterChanges) {
    if (!tankIds.has(w.tankId)) push("数据链", `换水 ${w.id}`, `鱼缸 ${w.tankId}`, "换水指向不存在的鱼缸");
    if (!recordIds.has(w.recordId)) push("数据链", `换水 ${w.id}`, `记录 ${w.recordId}`, "换水指向不存在的检测记录");
    if (w.status === "completed" && !w.estimate)
      push("数据链", `换水 ${w.id}`, "缺回填估算", "已完成换水必须回填估算浓度");
  }
  return out;
}

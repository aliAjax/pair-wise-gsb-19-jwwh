// 落盘层：localStorage 持久化 + 首次启动的示例数据
import {
  AppState,
  Conflict,
  TestRecord,
  Treatment,
  WaterChange,
  detectAnomalies,
  estimateAfterWaterChange,
} from "./water";

const STORAGE_KEY = "hxwl05-water-tracker-v1";

export function emptyState(): AppState {
  return { tanks: [], records: [], treatments: [], waterChanges: [], conflicts: [], savedAt: null };
}

export function loadState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return seedState();
    const parsed = JSON.parse(raw) as AppState;
    if (!Array.isArray(parsed.tanks) || !Array.isArray(parsed.records)) return seedState();
    return {
      tanks: parsed.tanks,
      records: parsed.records,
      treatments: parsed.treatments ?? [],
      waterChanges: parsed.waterChanges ?? [],
      conflicts: parsed.conflicts ?? [],
      savedAt: parsed.savedAt ?? null,
    };
  } catch {
    return seedState();
  }
}

export function saveState(state: AppState): AppState {
  const next = { ...state, savedAt: new Date().toISOString() };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function resetState(): AppState {
  localStorage.removeItem(STORAGE_KEY);
  return seedState();
}

function iso(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3600_000).toISOString();
}

/** 示例数据：覆盖 正常 / 异常未关闭禁止换水 / 已完成换水回填 / 修正版本链 四种场景 */
export function seedState(): AppState {
  const tanks = [
    { id: "tank-cao", name: "草缸A", kind: "草缸", volumeL: 120, createdAt: iso(24 * 30) },
    { id: "tank-hai", name: "海缸B", kind: "海缸", volumeL: 200, createdAt: iso(24 * 30) },
    { id: "tank-fan", name: "繁殖缸C", kind: "繁殖缸", volumeL: 60, createdAt: iso(24 * 30) },
  ];

  const records: TestRecord[] = [];
  const treatments: Treatment[] = [];
  const waterChanges: WaterChange[] = [];
  const conflicts: Conflict[] = [];

  const addRecord = (r: Omit<TestRecord, "anomalies">): TestRecord => {
    const full: TestRecord = { ...r, anomalies: detectAnomalies(r.values) };
    records.push(full);
    return full;
  };

  // 草缸A：两次检测 + 一次已完成换水（30%），当前读数来自回填估算
  addRecord({
    id: "rec-cao-1",
    groupId: "rec-cao-1",
    version: 1,
    supersedes: null,
    correctionReason: null,
    tankId: "tank-cao",
    measuredAt: iso(24 * 3),
    values: { ph: 6.8, ammonia: 0.1, nitrate: 18, temperature: 25 },
    waterChangePct: 0,
    createdAt: iso(24 * 3),
  });
  const cao2 = addRecord({
    id: "rec-cao-2",
    groupId: "rec-cao-2",
    version: 1,
    supersedes: null,
    correctionReason: null,
    tankId: "tank-cao",
    measuredAt: iso(26),
    values: { ph: 6.7, ammonia: 0.12, nitrate: 32, temperature: 24.5 },
    waterChangePct: 30,
    createdAt: iso(26),
  });
  waterChanges.push({
    id: "wc-cao-1",
    tankId: "tank-cao",
    recordId: cao2.id,
    percent: 30,
    status: "completed",
    createdAt: iso(26),
    completedAt: iso(24),
    estimate: estimateAfterWaterChange(cao2.values, 30),
    baseRecordId: cao2.id,
  });

  // 海缸B：最新检测 pH / 氨氮异常，处置未关闭 → 20% 换水被禁止完成
  addRecord({
    id: "rec-hai-1",
    groupId: "rec-hai-1",
    version: 1,
    supersedes: null,
    correctionReason: null,
    tankId: "tank-hai",
    measuredAt: iso(48),
    values: { ph: 8.1, ammonia: 0.05, nitrate: 10, temperature: 26 },
    waterChangePct: 0,
    createdAt: iso(48),
  });
  const hai2 = addRecord({
    id: "rec-hai-2",
    groupId: "rec-hai-2",
    version: 1,
    supersedes: null,
    correctionReason: null,
    tankId: "tank-hai",
    measuredAt: iso(5),
    values: { ph: 8.8, ammonia: 0.3, nitrate: 12, temperature: 27 },
    waterChangePct: 20,
    createdAt: iso(5),
  });
  for (const a of hai2.anomalies) {
    treatments.push({
      id: `tr-hai-${a.metric}`,
      tankId: "tank-hai",
      recordId: hai2.id,
      metric: a.metric,
      rule: a.rule,
      value: a.value,
      action:
        a.metric === "ph"
          ? "停喂减料，部分换水并加强爆氧，复测 pH"
          : "添加硝化细菌，停喂一天，次日复测氨氮",
      status: "open",
      createdAt: iso(5),
      closedAt: null,
      closeNote: null,
    });
  }
  waterChanges.push({
    id: "wc-hai-1",
    tankId: "tank-hai",
    recordId: hai2.id,
    percent: 20,
    status: "planned",
    createdAt: iso(5),
    completedAt: null,
    estimate: null,
    baseRecordId: null,
  });

  // 繁殖缸C：v1 硝酸盐异常 → v2 修正恢复正常，处置已关闭，冲突留痕
  const fan1 = addRecord({
    id: "rec-fan-1",
    groupId: "rec-fan-1",
    version: 1,
    supersedes: null,
    correctionReason: null,
    tankId: "tank-fan",
    measuredAt: iso(24 * 4),
    values: { ph: 7.2, ammonia: 0.18, nitrate: 45, temperature: 23 },
    waterChangePct: 0,
    createdAt: iso(24 * 4),
  });
  treatments.push({
    id: "tr-fan-nitrate",
    tankId: "tank-fan",
    recordId: fan1.id,
    metric: "nitrate",
    rule: "硝酸盐 > 40mg/L",
    value: 45,
    action: "换水 25%，清洗过滤棉，减少投喂",
    status: "closed",
    createdAt: iso(24 * 4),
    closedAt: iso(24 * 4 - 3),
    closeNote: "复测并修正为 v2，硝酸盐恢复正常",
  });
  addRecord({
    id: "rec-fan-1-v2",
    groupId: "rec-fan-1",
    version: 2,
    supersedes: fan1.id,
    correctionReason: "试剂批次误差，用新试剂复测后修正",
    tankId: "tank-fan",
    measuredAt: iso(24 * 4),
    values: { ph: 7.2, ammonia: 0.18, nitrate: 38, temperature: 23 },
    waterChangePct: 0,
    createdAt: iso(24 * 4 - 3),
  });
  conflicts.push({
    id: "cf-fan-1",
    kind: "correction",
    tankId: "tank-fan",
    metric: "硝酸盐",
    oldValue: "45 mg/L",
    newValue: "38 mg/L",
    rule: "硝酸盐 > 40mg/L → 已恢复正常",
    createdAt: iso(24 * 4 - 3),
  });

  return { tanks, records, treatments, waterChanges, conflicts, savedAt: null };
}

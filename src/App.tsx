import { useEffect, useMemo, useState } from "react";
import "./styles.css";
import {
  AppState,
  Conflict,
  METRICS,
  METRIC_ORDER,
  MetricKey,
  MetricValues,
  Tank,
  TestRecord,
  Treatment,
  WaterChange,
  correctionConflicts,
  currentReading,
  detectAnomalies,
  estimateAfterWaterChange,
  estimateDriftConflicts,
  formatMetric,
  latestRecord,
  latestVersions,
  openTreatments,
  recordsOfTank,
  uid,
  validateChain,
} from "./water";
import { loadState, resetState, saveState } from "./storage";

// ---------- 时间工具 ----------

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const TANK_KINDS = ["草缸", "海缸", "三湖缸", "繁殖缸", "其他"];

// ---------- 表单 ----------

interface TestFormState {
  mode: "new" | "correct";
  targetId: string | null; // 被修正记录（该链最新版本）的 id
  measuredAt: string;
  ph: string;
  ammonia: string;
  nitrate: string;
  temperature: string;
  waterChangePct: string;
  reason: string;
  actions: Record<MetricKey, string>;
}

function blankForm(): TestFormState {
  return {
    mode: "new",
    targetId: null,
    measuredAt: toLocalInput(new Date()),
    ph: "",
    ammonia: "",
    nitrate: "",
    temperature: "",
    waterChangePct: "0",
    reason: "",
    actions: { ph: "", ammonia: "", nitrate: "", temperature: "" },
  };
}

function parseNum(s: string): number | null {
  if (s.trim() === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ---------- 小组件 ----------

function StatusDot({ tone }: { tone: "ok" | "warn" | "danger" }) {
  return <i className={`status-dot ${tone}`} />;
}

function MetricValue({ metric, value }: { metric: MetricKey; value: number }) {
  const hit = detectAnomalies({ ph: 7, ammonia: 0, nitrate: 0, temperature: 25, ...{ [metric]: value } }).some(
    (a) => a.metric === metric
  );
  return (
    <strong className={hit ? "metric-danger" : "metric-ok"}>
      {formatMetric(metric, value)}
    </strong>
  );
}

// ---------- 主应用 ----------

export default function App() {
  const [initial] = useState<AppState>(() => loadState());
  const [state, setState] = useState<AppState>(initial);
  const [selectedTankId, setSelectedTankId] = useState<string>(initial.tanks[0]?.id ?? "");
  const [form, setForm] = useState<TestFormState>(blankForm);
  const [toast, setToast] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [closeNotes, setCloseNotes] = useState<Record<string, string>>({});
  const [newTank, setNewTank] = useState({ name: "", kind: TANK_KINDS[0], volumeL: "100" });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const commit = (next: AppState) => setState(saveState(next));

  const tank = state.tanks.find((t) => t.id === selectedTankId) ?? state.tanks[0] ?? null;
  const tankId = tank?.id ?? "";

  const chainConflicts = useMemo(() => validateChain(state, state.savedAt ?? ""), [state]);
  const allConflicts = useMemo(
    () =>
      [...state.conflicts, ...chainConflicts].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [state.conflicts, chainConflicts]
  );

  const reading = tank ? currentReading(state, tankId) : null;
  const tankOpenTreatments = tank ? openTreatments(state, tankId) : [];
  const waterChangeBlocked = tankOpenTreatments.length > 0;

  // ---------- 动作 ----------

  function addTank() {
    const volumeL = parseNum(newTank.volumeL);
    if (!newTank.name.trim() || volumeL === null || volumeL <= 0) {
      setToast({ type: "err", text: "请填写鱼缸名称和有效水体体积" });
      return;
    }
    const t: Tank = {
      id: uid("tank"),
      name: newTank.name.trim(),
      kind: newTank.kind,
      volumeL,
      createdAt: new Date().toISOString(),
    };
    commit({ ...state, tanks: [...state.tanks, t] });
    setSelectedTankId(t.id);
    setNewTank({ name: "", kind: TANK_KINDS[0], volumeL: "100" });
    setToast({ type: "ok", text: `鱼缸「${t.name}」已创建并落盘` });
  }

  function startCorrect(record: TestRecord) {
    const openForRecord = state.treatments.filter(
      (t) => t.recordId === record.id && t.status === "open"
    );
    const actions = { ...blankForm().actions };
    for (const tr of openForRecord) actions[tr.metric] = tr.action;
    setForm({
      mode: "correct",
      targetId: record.id,
      measuredAt: toLocalInput(new Date(record.measuredAt)),
      ph: String(record.values.ph),
      ammonia: String(record.values.ammonia),
      nitrate: String(record.values.nitrate),
      temperature: String(record.values.temperature),
      waterChangePct: String(record.waterChangePct),
      reason: "",
      actions,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    setToast({ type: "ok", text: `正在修正记录 v${record.version}，保存后生成新版本，原记录不可覆盖` });
  }

  function saveTest() {
    if (!tank) return;
    const ph = parseNum(form.ph);
    const ammonia = parseNum(form.ammonia);
    const nitrate = parseNum(form.nitrate);
    const temperature = parseNum(form.temperature);
    const pct = parseNum(form.waterChangePct);
    if (ph === null || ammonia === null || nitrate === null || temperature === null || pct === null) {
      setToast({ type: "err", text: "请完整填写 pH、氨氮、硝酸盐、温度和换水量" });
      return;
    }
    if (pct < 0 || pct > 100) {
      setToast({ type: "err", text: "换水量需在 0–100% 之间" });
      return;
    }
    if (!form.measuredAt) {
      setToast({ type: "err", text: "请填写检测时间" });
      return;
    }
    const values: MetricValues = { ph, ammonia, nitrate, temperature };
    const anomalies = detectAnomalies(values);

    // 规则：异常必须先登记处置动作才能保存
    for (const a of anomalies) {
      if (!form.actions[a.metric].trim()) {
        setToast({ type: "err", text: `「${a.rule}」未登记处置动作，禁止保存` });
        return;
      }
    }

    const now = new Date().toISOString();
    const measuredAt = new Date(form.measuredAt).toISOString();

    if (form.mode === "correct") {
      const target = state.records.find((r) => r.id === form.targetId);
      if (!target) {
        setToast({ type: "err", text: "被修正的记录不存在" });
        return;
      }
      if (!form.reason.trim()) {
        setToast({ type: "err", text: "修正必须填写原因" });
        return;
      }
      const unchanged =
        METRIC_ORDER.every((m) => target.values[m] === values[m]) && target.waterChangePct === pct;
      if (unchanged) {
        setToast({ type: "err", text: "未检测到任何数值变化，无需生成修正版本" });
        return;
      }
      const record: TestRecord = {
        id: uid("rec"),
        groupId: target.groupId,
        version: target.version + 1,
        supersedes: target.id,
        correctionReason: form.reason.trim(),
        tankId,
        measuredAt,
        values,
        waterChangePct: pct,
        anomalies,
        createdAt: now,
      };
      // 处置链：同指标同规则的未关闭处置沿用到新版本，否则新建
      let treatments = [...state.treatments];
      for (const a of anomalies) {
        const existing = treatments.find(
          (t) =>
            t.recordId === target.id && t.status === "open" && t.metric === a.metric && t.rule === a.rule
        );
        if (existing) {
          treatments = treatments.map((t) =>
            t.id === existing.id
              ? { ...t, recordId: record.id, value: a.value, action: form.actions[a.metric].trim() }
              : t
          );
        } else {
          treatments.push({
            id: uid("tr"),
            tankId,
            recordId: record.id,
            metric: a.metric,
            rule: a.rule,
            value: a.value,
            action: form.actions[a.metric].trim(),
            status: "open",
            createdAt: now,
            closedAt: null,
            closeNote: null,
          });
        }
      }
      // 修正换水量时同步未完成的换水计划，保持链一致
      const waterChanges = state.waterChanges.map((w) =>
        w.recordId === target.id && w.status === "planned" ? { ...w, percent: pct } : w
      );
      const conflicts = correctionConflicts(tankId, target, record, now);
      commit({
        ...state,
        records: [...state.records, record],
        treatments,
        waterChanges,
        conflicts: [...state.conflicts, ...conflicts],
      });
      setForm(blankForm());
      setToast({
        type: "ok",
        text: `已保存修正版本 v${record.version}（原 v${target.version} 保留不可覆盖）${
          conflicts.length ? `，产生 ${conflicts.length} 条冲突记录` : ""
        }`,
      });
      return;
    }

    // 新检测：若当前读数来自换水回填估算，实测与估算偏差列入冲突
    const drift =
      reading && reading.source === "estimate" && measuredAt > reading.at
        ? estimateDriftConflicts(tankId, reading.values, values, now)
        : [];

    const record: TestRecord = {
      id: uid("rec"),
      groupId: "",
      version: 1,
      supersedes: null,
      correctionReason: null,
      tankId,
      measuredAt,
      values,
      waterChangePct: pct,
      anomalies,
      createdAt: now,
    };
    record.groupId = record.id;

    const treatments: Treatment[] = anomalies.map((a) => ({
      id: uid("tr"),
      tankId,
      recordId: record.id,
      metric: a.metric,
      rule: a.rule,
      value: a.value,
      action: form.actions[a.metric].trim(),
      status: "open",
      createdAt: now,
      closedAt: null,
      closeNote: null,
    }));

    const waterChanges: WaterChange[] =
      pct > 0
        ? [
            {
              id: uid("wc"),
              tankId,
              recordId: record.id,
              percent: pct,
              status: "planned",
              createdAt: now,
              completedAt: null,
              estimate: null,
              baseRecordId: null,
            },
          ]
        : [];

    commit({
      ...state,
      records: [...state.records, record],
      treatments: [...state.treatments, ...treatments],
      waterChanges: [...state.waterChanges, ...waterChanges],
      conflicts: [...state.conflicts, ...drift],
    });
    setForm(blankForm());
    setToast({
      type: "ok",
      text:
        anomalies.length > 0
          ? `检测已保存，${anomalies.length} 项异常已登记处置（未关闭前禁止完成换水）`
          : "检测已保存并落盘",
    });
  }

  function closeTreatment(id: string) {
    const note = (closeNotes[id] ?? "").trim();
    if (!note) {
      setToast({ type: "err", text: "关闭异常需填写关闭说明（如复测结果）" });
      return;
    }
    commit({
      ...state,
      treatments: state.treatments.map((t) =>
        t.id === id ? { ...t, status: "closed", closedAt: new Date().toISOString(), closeNote: note } : t
      ),
    });
    setCloseNotes((m) => ({ ...m, [id]: "" }));
    setToast({ type: "ok", text: "处置已关闭" });
  }

  function completeWaterChange(id: string) {
    const wc = state.waterChanges.find((w) => w.id === id);
    if (!wc || wc.status !== "planned") return;
    // 规则：异常未关闭时禁止记录换水完成
    const open = openTreatments(state, wc.tankId);
    if (open.length > 0) {
      setToast({
        type: "err",
        text: `存在 ${open.length} 项未关闭异常处置，禁止记录换水完成`,
      });
      return;
    }
    const base = latestRecord(state, wc.tankId);
    if (!base) {
      setToast({ type: "err", text: "该鱼缸还没有检测记录，无法回填估算" });
      return;
    }
    const now = new Date().toISOString();
    const estimate = estimateAfterWaterChange(base.values, wc.percent);
    commit({
      ...state,
      waterChanges: state.waterChanges.map((w) =>
        w.id === id
          ? { ...w, status: "completed", completedAt: now, estimate, baseRecordId: base.id }
          : w
      ),
    });
    setToast({
      type: "ok",
      text: `换水 ${wc.percent}% 已完成，已按比例回填估算浓度`,
    });
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `water-tracker-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function resetAll() {
    if (!window.confirm("确定清空全部本地数据并恢复示例吗？")) return;
    const fresh = resetState();
    setState(saveState(fresh));
    setSelectedTankId(fresh.tanks[0]?.id ?? "");
    setForm(blankForm());
    setToast({ type: "ok", text: "已恢复示例数据" });
  }

  // ---------- 表单派生 ----------

  const parsedValues: MetricValues = {
    ph: parseNum(form.ph) ?? 7,
    ammonia: parseNum(form.ammonia) ?? 0,
    nitrate: parseNum(form.nitrate) ?? 0,
    temperature: parseNum(form.temperature) ?? 25,
  };
  const filled =
    parseNum(form.ph) !== null &&
    parseNum(form.ammonia) !== null &&
    parseNum(form.nitrate) !== null &&
    parseNum(form.temperature) !== null;
  const liveAnomalies = filled ? detectAnomalies(parsedValues) : [];
  const correctTarget =
    form.mode === "correct" ? state.records.find((r) => r.id === form.targetId) ?? null : null;

  // ---------- 渲染 ----------

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-05 · 本地落盘 {state.savedAt ? `· 上次保存 ${fmtTime(state.savedAt)}` : ""}</p>
          <h1>多鱼缸水质追踪台</h1>
          <p className="subtitle">
            检测时间、pH、氨氮、硝酸盐、温度与换水量一体登记；异常必须先登记处置动作才能保存，
            异常未关闭禁止完成换水；换水完成按比例回填估算浓度；记录不可覆盖，修正生成带原因的新版本。
          </p>
        </div>
        <div className="stack-card">
          <span>阈值规则</span>
          <strong>
            pH 6–8.5 · 氨氮 ≤0.2mg/L
            <br />
            硝酸盐 ≤40mg/L · 温度 22–30℃
          </strong>
          <div className="row-actions">
            <button onClick={exportJson}>导出 JSON</button>
            <button onClick={resetAll}>恢复示例</button>
          </div>
        </div>
      </section>

      {toast && <div className={`toast ${toast.type}`}>{toast.text}</div>}

      <div className="layout">
        <aside className="panel narrow">
          <h2>鱼缸</h2>
          <div className="tank-list">
            {state.tanks.map((t) => {
              const open = openTreatments(state, t.id).length;
              const planned = state.waterChanges.some(
                (w) => w.tankId === t.id && w.status === "planned"
              );
              const tone = open > 0 ? "danger" : planned ? "warn" : "ok";
              const label = open > 0 ? `异常未关闭 ×${open}` : planned ? "待换水" : "正常";
              return (
                <button
                  key={t.id}
                  className={`tank-item ${t.id === tankId ? "active" : ""}`}
                  onClick={() => {
                    setSelectedTankId(t.id);
                    setForm(blankForm());
                  }}
                >
                  <span className="tank-name">
                    <StatusDot tone={tone} /> {t.name}
                  </span>
                  <span className="tank-meta">
                    {t.kind} · {t.volumeL}L · {label}
                  </span>
                </button>
              );
            })}
          </div>
          <h2>新增鱼缸</h2>
          <div className="stack-form">
            <input
              placeholder="鱼缸名称"
              value={newTank.name}
              onChange={(e) => setNewTank({ ...newTank, name: e.target.value })}
            />
            <select value={newTank.kind} onChange={(e) => setNewTank({ ...newTank, kind: e.target.value })}>
              {TANK_KINDS.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <input
              type="number"
              min="1"
              placeholder="水体体积 L"
              value={newTank.volumeL}
              onChange={(e) => setNewTank({ ...newTank, volumeL: e.target.value })}
            />
            <button className="primary-action" onClick={addTank}>
              创建鱼缸
            </button>
          </div>
        </aside>

        <div className="main-col">
          {!tank && <section className="panel">请先创建一个鱼缸。</section>}

          {tank && (
            <>
              <section className="metrics-grid">
                {METRIC_ORDER.map((m) => (
                  <article key={m} className="metric-card">
                    <span>
                      {METRICS[m].label}
                      {METRICS[m].unit ? `（${METRICS[m].unit}）` : ""}
                    </span>
                    {reading ? (
                      <>
                        <MetricValue metric={m} value={reading.values[m]} />
                        <em className={`source-tag ${reading.source}`}>
                          {reading.source === "estimate" ? "换水回填估算" : "实测"} · {fmtTime(reading.at)}
                        </em>
                      </>
                    ) : (
                      <strong className="metric-none">暂无数据</strong>
                    )}
                  </article>
                ))}
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p>{form.mode === "correct" ? `修正 ${tank.name} · 目标 v${correctTarget?.version}` : tank.name}</p>
                    <h2>{form.mode === "correct" ? "新建修正版本" : "登记检测"}</h2>
                  </div>
                  {form.mode === "correct" && (
                    <button onClick={() => setForm(blankForm())}>取消修正</button>
                  )}
                </div>
                {form.mode === "correct" && (
                  <p className="banner warn">
                    原记录保存后不可覆盖：本次保存将生成 v{(correctTarget?.version ?? 1) + 1} 新版本，必须填写修正原因。
                  </p>
                )}
                <div className="field-grid">
                  <label>
                    <span>检测时间</span>
                    <input
                      type="datetime-local"
                      value={form.measuredAt}
                      onChange={(e) => setForm({ ...form, measuredAt: e.target.value })}
                    />
                  </label>
                  <label>
                    <span>pH（6–8.5）</span>
                    <input type="number" step="0.1" value={form.ph} onChange={(e) => setForm({ ...form, ph: e.target.value })} placeholder="如 7.2" />
                  </label>
                  <label>
                    <span>氨氮 mg/L（≤0.2）</span>
                    <input type="number" step="0.01" value={form.ammonia} onChange={(e) => setForm({ ...form, ammonia: e.target.value })} placeholder="如 0.10" />
                  </label>
                  <label>
                    <span>硝酸盐 mg/L（≤40）</span>
                    <input type="number" step="0.1" value={form.nitrate} onChange={(e) => setForm({ ...form, nitrate: e.target.value })} placeholder="如 18" />
                  </label>
                  <label>
                    <span>温度 ℃（22–30）</span>
                    <input type="number" step="0.1" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} placeholder="如 25" />
                  </label>
                  <label>
                    <span>本次换水量 %</span>
                    <input type="number" step="1" min="0" max="100" value={form.waterChangePct} onChange={(e) => setForm({ ...form, waterChangePct: e.target.value })} />
                  </label>
                </div>

                {liveAnomalies.length > 0 && (
                  <div className="anomaly-box">
                    <p className="banner danger">
                      检测到 {liveAnomalies.length} 项异常，必须先逐项登记处置动作才能保存：
                    </p>
                    {liveAnomalies.map((a) => (
                      <label key={a.metric} className="action-field">
                        <span>
                          处置动作 · {METRICS[a.metric].label} {formatMetric(a.metric, a.value)}（{a.rule}）
                        </span>
                        <input
                          placeholder="如：停喂、部分换水、添加硝化细菌……"
                          value={form.actions[a.metric]}
                          onChange={(e) =>
                            setForm({ ...form, actions: { ...form.actions, [a.metric]: e.target.value } })
                          }
                        />
                      </label>
                    ))}
                  </div>
                )}

                {form.mode === "correct" && (
                  <label className="action-field">
                    <span>修正原因（必填，随版本永久保存）</span>
                    <input
                      placeholder="如：试剂批次误差，复测后修正"
                      value={form.reason}
                      onChange={(e) => setForm({ ...form, reason: e.target.value })}
                    />
                  </label>
                )}

                <div className="row-actions">
                  <button className="primary-action" onClick={saveTest}>
                    {form.mode === "correct" ? "保存修正版本" : "保存检测记录"}
                  </button>
                  {form.mode === "new" && liveAnomalies.length > 0 && (
                    <span className="hint">保存后异常处置为「未关闭」，期间禁止完成换水</span>
                  )}
                </div>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p>{tank.name}</p>
                    <h2>异常处置（{tankOpenTreatments.length} 项未关闭）</h2>
                  </div>
                </div>
                {state.treatments.filter((t) => t.tankId === tankId).length === 0 && (
                  <p className="muted-text">暂无处置记录。</p>
                )}
                <div className="record-list">
                  {state.treatments
                    .filter((t) => t.tankId === tankId)
                    .sort((a, b) => (a.status === b.status ? b.createdAt.localeCompare(a.createdAt) : a.status === "open" ? -1 : 1))
                    .map((t) => (
                      <article key={t.id} className={`record-card ${t.status === "closed" ? "muted-card" : ""}`}>
                        <div className={`record-index ${t.status === "open" ? "danger-bg" : "ok-bg"}`}>
                          {t.status === "open" ? "未" : "已"}
                        </div>
                        <div>
                          <h3>
                            {METRICS[t.metric].label} {formatMetric(t.metric, t.value)}
                            <span className="rule-tag">{t.rule}</span>
                          </h3>
                          <p>处置：{t.action}</p>
                          <p className="muted-text">
                            登记 {fmtTime(t.createdAt)}
                            {t.status === "closed" && ` · 关闭 ${fmtTime(t.closedAt)} · ${t.closeNote}`}
                          </p>
                          {t.status === "open" && (
                            <div className="inline-close">
                              <input
                                placeholder="关闭说明（如复测结果）"
                                value={closeNotes[t.id] ?? ""}
                                onChange={(e) => setCloseNotes((m) => ({ ...m, [t.id]: e.target.value }))}
                              />
                              <button onClick={() => closeTreatment(t.id)}>关闭异常</button>
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                </div>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p>{tank.name}</p>
                    <h2>换水记录</h2>
                  </div>
                  {waterChangeBlocked && <span className="badge danger">异常未关闭 · 禁止完成换水</span>}
                </div>
                {state.waterChanges.filter((w) => w.tankId === tankId).length === 0 && (
                  <p className="muted-text">暂无换水记录，登记检测时填写换水量即可生成计划。</p>
                )}
                <div className="record-list">
                  {state.waterChanges
                    .filter((w) => w.tankId === tankId)
                    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                    .map((w) => (
                      <article key={w.id} className={`record-card ${w.status === "completed" ? "" : "muted-card"}`}>
                        <div className={`record-index ${w.status === "completed" ? "ok-bg" : "warn-bg"}`}>
                          {w.percent}%
                        </div>
                        <div>
                          <h3>{w.status === "completed" ? `已完成 · ${fmtTime(w.completedAt)}` : "计划待完成"}</h3>
                          {w.status === "completed" && w.estimate ? (
                            <p>
                              按比例回填估算：pH {w.estimate.ph.toFixed(2)} · 氨氮 {w.estimate.ammonia.toFixed(3)} mg/L ·
                              硝酸盐 {w.estimate.nitrate.toFixed(1)} mg/L · 温度 {w.estimate.temperature.toFixed(1)}℃
                            </p>
                          ) : (
                            <p className="muted-text">登记 {fmtTime(w.createdAt)}</p>
                          )}
                          {w.status === "planned" && (
                            <div className="row-actions">
                              <button
                                className="primary-action"
                                disabled={waterChangeBlocked}
                                title={waterChangeBlocked ? "存在未关闭异常处置" : ""}
                                onClick={() => completeWaterChange(w.id)}
                              >
                                完成换水并回填估算
                              </button>
                              {waterChangeBlocked && <span className="hint">需先关闭全部异常处置</span>}
                            </div>
                          )}
                        </div>
                      </article>
                    ))}
                </div>
              </section>

              <section className="panel">
                <div className="section-heading">
                  <div>
                    <p>{tank.name}</p>
                    <h2>检测记录链</h2>
                  </div>
                  <span className="badge">保存后不可覆盖 · 修正生成新版本</span>
                </div>
                {recordsOfTank(state, tankId).length === 0 && <p className="muted-text">暂无检测记录。</p>}
                <div className="record-list">
                  {latestVersions(recordsOfTank(state, tankId))
                    .sort((a, b) => b.measuredAt.localeCompare(a.measuredAt))
                    .map((latest) => {
                      const chain = state.records
                        .filter((r) => r.groupId === latest.groupId)
                        .sort((a, b) => b.version - a.version);
                      return (
                        <article key={latest.groupId} className="record-card chain-card">
                          <div className="record-index">{String(latest.version).padStart(2, "0")}</div>
                          <div>
                            {chain.map((r) => (
                              <div key={r.id} className={`version-block ${r.version !== latest.version ? "superseded" : ""}`}>
                                <h3>
                                  v{r.version} · {fmtTime(r.measuredAt)}
                                  {r.anomalies.length > 0 ? (
                                    <span className="badge danger">{r.anomalies.length} 项异常</span>
                                  ) : (
                                    <span className="badge ok">正常</span>
                                  )}
                                  {r.version !== latest.version && <span className="badge">已被 v{latest.version} 取代</span>}
                                </h3>
                                <p>
                                  pH {r.values.ph} · 氨氮 {r.values.ammonia} mg/L · 硝酸盐 {r.values.nitrate} mg/L ·{" "}
                                  {r.values.temperature}℃ · 换水 {r.waterChangePct}%
                                </p>
                                {r.anomalies.length > 0 && (
                                  <p className="muted-text">触发：{r.anomalies.map((a) => a.rule).join("；")}</p>
                                )}
                                {r.correctionReason && <p className="muted-text">修正原因：{r.correctionReason}</p>}
                                {r.version === latest.version && (
                                  <div className="row-actions">
                                    <button onClick={() => startCorrect(r)}>修正（新建版本）</button>
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </article>
                      );
                    })}
                </div>
              </section>
            </>
          )}

          <section className="panel">
            <div className="section-heading">
              <div>
                <p>全缸</p>
                <h2>冲突与数据链（{allConflicts.length}）</h2>
              </div>
              <span className={`badge ${chainConflicts.length ? "danger" : "ok"}`}>
                {chainConflicts.length ? `数据链异常 ×${chainConflicts.length}` : "刷新后链校验一致"}
              </span>
            </div>
            {allConflicts.length === 0 && <p className="muted-text">暂无冲突：修正版本、估算偏差与链校验均一致。</p>}
            <div className="record-list">
              {allConflicts.map((c: Conflict) => (
                <article key={c.id} className="record-card conflict-card">
                  <div className="record-index warn-bg">冲</div>
                  <div>
                    <h3>
                      {state.tanks.find((t) => t.id === c.tankId)?.name ?? "数据链"} · {c.metric}
                      <span className="rule-tag">{c.rule}</span>
                    </h3>
                    <p>
                      原值 <strong>{c.oldValue}</strong> → 新值 <strong>{c.newValue}</strong>
                    </p>
                    <p className="muted-text">{fmtTime(c.createdAt)}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

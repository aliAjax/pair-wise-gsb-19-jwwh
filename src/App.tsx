import { useEffect, useMemo, useRef, useState } from "react";
import "./styles.css";
import type {
  Anomaly,
  AppState,
  Measurement,
  MetricKey,
  MetricValues,
  Tank,
  WaterChange,
} from "./domain";
import {
  METRIC_ORDER,
  RULES,
  RULE_BY_METRIC,
  activeRecords,
  computeEstimate,
  detectConflicts,
  evaluateValues,
  fmtMetric,
  openAnomalies,
  uid,
} from "./domain";
import { isValidState, loadState, resetState, saveState } from "./store";

const TANK_TYPES = ["草缸", "海缸", "三湖缸", "繁殖缸"];

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function nowLocalInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(iso?: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.replace("T", " ");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- 检测 / 修正表单 ----------

interface DraftStrings {
  measuredAt: string;
  ph: string;
  ammonia: string;
  nitrate: string;
  temperature: string;
}

const VALUE_LIMITS: Record<MetricKey, { min: number; max: number }> = {
  ph: { min: 0, max: 14 },
  ammonia: { min: 0, max: 50 },
  nitrate: { min: 0, max: 1000 },
  temperature: { min: 0, max: 45 },
};

interface MeasurementPayload {
  values: MetricValues;
  measuredAt: string;
  reason: string;
  disposals: Partial<Record<MetricKey, string>>;
}

function MeasurementForm({
  title,
  initial,
  requireReason,
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: DraftStrings;
  requireReason: boolean;
  onSubmit: (payload: MeasurementPayload) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DraftStrings>(initial);
  const [reason, setReason] = useState("");
  const [disposals, setDisposals] = useState<Partial<Record<MetricKey, string>>>({});
  const [error, setError] = useState("");

  const nums: MetricValues = {
    ph: parseFloat(draft.ph),
    ammonia: parseFloat(draft.ammonia),
    nitrate: parseFloat(draft.nitrate),
    temperature: parseFloat(draft.temperature),
  };
  const rangeError = METRIC_ORDER.find((m) => {
    const v = nums[m];
    return !Number.isFinite(v) || v < VALUE_LIMITS[m].min || v > VALUE_LIMITS[m].max;
  });
  const triggered = rangeError ? [] : evaluateValues(nums);

  const set = (key: keyof DraftStrings) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));

  const handleSubmit = () => {
    if (!draft.measuredAt) return setError("请填写检测时间");
    const bad = METRIC_ORDER.find((m) => {
      const v = nums[m];
      return !Number.isFinite(v) || v < VALUE_LIMITS[m].min || v > VALUE_LIMITS[m].max;
    });
    if (bad) {
      const r = RULE_BY_METRIC[bad];
      return setError(`${r.label}需为 ${VALUE_LIMITS[bad].min}~${VALUE_LIMITS[bad].max} 之间的数字`);
    }
    if (requireReason && !reason.trim()) return setError("修正必须填写原因（原记录不可覆盖，将生成新版本）");
    for (const t of triggered) {
      if (!disposals[t.rule.metric]?.trim()) {
        return setError(`「${t.rule.describe}」被触发，必须先登记处置动作才能保存`);
      }
    }
    onSubmit({ values: nums, measuredAt: draft.measuredAt, reason: reason.trim(), disposals });
  };

  return (
    <div className="form-panel">
      <h3>{title}</h3>
      <div className="field-grid">
        <label>
          <span>检测时间</span>
          <input type="datetime-local" value={draft.measuredAt} onChange={set("measuredAt")} />
        </label>
        {METRIC_ORDER.map((m) => {
          const r = RULE_BY_METRIC[m];
          const abnormal = !rangeError && r.test(nums[m]);
          return (
            <label key={m} className={abnormal ? "field-abnormal" : ""}>
              <span>
                {r.label}
                {r.unit ? `（${r.unit}）` : ""}
                {abnormal ? " · 异常" : ""}
              </span>
              <input type="number" step="any" value={draft[m]} onChange={set(m)} placeholder={`填写${r.label}`} />
            </label>
          );
        })}
      </div>

      {triggered.length > 0 && (
        <div className="disposal-block">
          <p className="disposal-title">触发 {triggered.length} 项异常规则，须逐项登记处置动作后才能保存：</p>
          {triggered.map((t) => (
            <label key={t.rule.metric}>
              <span>
                {t.rule.label} {fmtMetric(t.rule.metric, t.value)} · {t.rule.describe}
              </span>
              <input
                value={disposals[t.rule.metric] ?? ""}
                placeholder="处置动作，如：停喂 / 换水 30% / 添加硝化细菌"
                onChange={(e) => setDisposals((d) => ({ ...d, [t.rule.metric]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}

      {requireReason && (
        <label className="reason-field">
          <span>修正原因（必填，保存后生成新版本，原记录保留不可覆盖）</span>
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="如：试纸复测，原读数偏高" />
        </label>
      )}

      {error && <p className="form-error">{error}</p>}
      <div className="form-actions">
        <button className="primary-action" onClick={handleSubmit}>
          保存
        </button>
        <button onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

// ---------- 检测记录卡片 ----------

function AnomalyBlock({
  rec,
  anomaly,
  onAddDisposal,
  onClose,
}: {
  rec: Measurement;
  anomaly: Anomaly;
  onAddDisposal: (recordId: string, anomalyId: string, text: string) => void;
  onClose: (recordId: string, anomalyId: string) => void;
}) {
  const [text, setText] = useState("");
  const rule = RULE_BY_METRIC[anomaly.metric];
  return (
    <div className={`anomaly ${anomaly.status}`}>
      <div className="anomaly-head">
        <strong>
          {rule.label} {fmtMetric(anomaly.metric, anomaly.value)}
        </strong>
        <span className="rule-tag">{anomaly.rule}</span>
        <span className={`badge ${anomaly.status === "open" ? "badge-danger" : "badge-ok"}`}>
          {anomaly.status === "open" ? "异常未关闭" : "已关闭"}
        </span>
      </div>
      <ul className="disposal-list">
        {anomaly.disposals.map((d) => (
          <li key={d.id}>
            {d.text}
            <em>{fmtTime(d.createdAt)}</em>
          </li>
        ))}
        {anomaly.disposals.length === 0 && <li className="muted">尚未登记处置动作</li>}
      </ul>
      {anomaly.status === "open" && (
        <div className="anomaly-actions">
          <input
            value={text}
            placeholder="追加处置动作"
            onChange={(e) => setText(e.target.value)}
          />
          <button
            onClick={() => {
              if (!text.trim()) return;
              onAddDisposal(rec.id, anomaly.id, text.trim());
              setText("");
            }}
          >
            登记处置
          </button>
          <button
            className="ok-action"
            disabled={anomaly.disposals.length === 0}
            title={anomaly.disposals.length === 0 ? "需先登记处置动作" : "确认异常已处理完毕"}
            onClick={() => onClose(rec.id, anomaly.id)}
          >
            关闭异常
          </button>
        </div>
      )}
    </div>
  );
}

function RecordItem({
  rec,
  allRecords,
  isActive,
  onCorrect,
  onAddDisposal,
  onCloseAnomaly,
}: {
  rec: Measurement;
  allRecords: Measurement[];
  isActive: boolean;
  onCorrect: (rec: Measurement) => void;
  onAddDisposal: (recordId: string, anomalyId: string, text: string) => void;
  onCloseAnomaly: (recordId: string, anomalyId: string) => void;
}) {
  const [showHistory, setShowHistory] = useState(false);
  const byId = useMemo(() => new Map(allRecords.map((r) => [r.id, r])), [allRecords]);

  // 版本链：向前追溯被本记录替代的历代版本
  const history: Measurement[] = [];
  let cur: Measurement = rec;
  while (cur.supersedes) {
    const prev = byId.get(cur.supersedes);
    if (!prev) break;
    history.push(prev);
    cur = prev;
  }

  return (
    <article className={`record-card ${isActive ? "" : "record-old"}`}>
      <div className="record-index">{rec.kind === "estimate" ? "估" : `v${rec.version}`}</div>
      <div className="record-body">
        <div className="record-head">
          <h3>
            {rec.kind === "estimate" ? "换水回填估算" : "水质检测"}
            <span className="badge">{rec.kind === "estimate" ? "系统回填" : `版本 v${rec.version}`}</span>
            {!isActive && <span className="badge badge-muted">已被修正替代</span>}
          </h3>
          <span className="muted">检测时间 {fmtTime(rec.measuredAt)}</span>
        </div>
        <div className="value-grid">
          {METRIC_ORDER.map((m) => {
            const rule = RULE_BY_METRIC[m];
            const abnormal = rule.test(rec[m]);
            return (
              <div key={m} className={`value-cell ${abnormal ? "value-abnormal" : ""}`}>
                <span>{rule.label}</span>
                <strong>{fmtMetric(m, rec[m])}</strong>
              </div>
            );
          })}
        </div>
        {rec.reason && <p className="reason-line">原因：{rec.reason}</p>}

        {rec.anomalies.map((an) => (
          <AnomalyBlock key={an.id} rec={rec} anomaly={an} onAddDisposal={onAddDisposal} onClose={onCloseAnomaly} />
        ))}

        <div className="record-actions">
          {isActive && (
            <button onClick={() => onCorrect(rec)}>修正（新建版本）</button>
          )}
          {history.length > 0 && (
            <button className="ghost" onClick={() => setShowHistory((v) => !v)}>
              {showHistory ? "收起历史版本" : `历史版本（${history.length}）`}
            </button>
          )}
        </div>

        {showHistory &&
          history.map((h) => (
            <div key={h.id} className="history-item">
              <span className="badge badge-muted">v{h.version}</span>
              <span>{fmtTime(h.measuredAt)}</span>
              <span>
                {METRIC_ORDER.map((m) => `${RULE_BY_METRIC[m].label} ${fmtMetric(m, h[m])}`).join(" · ")}
              </span>
              {h.reason && <span className="muted">修正原因：{h.reason}</span>}
            </div>
          ))}
      </div>
    </article>
  );
}

// ---------- 主应用 ----------

type FormMode =
  | { kind: "create" }
  | { kind: "correct"; record: Measurement }
  | { kind: "water" }
  | { kind: "tank" }
  | null;

function App() {
  const [state, setState] = useState<AppState>(loadState);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [formMode, setFormMode] = useState<FormMode>(null);
  const [message, setMessage] = useState("");
  const [wcPercent, setWcPercent] = useState("30");
  const [tankDraft, setTankDraft] = useState({ name: "", type: TANK_TYPES[0], volumeL: "100" });
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => saveState(state), [state]);

  const conflicts = useMemo(() => detectConflicts(state), [state]);
  const selected: Tank | null = state.tanks.find((t) => t.id === selectedId) ?? state.tanks[0] ?? null;

  const totalOpenAnomalies = useMemo(
    () => state.tanks.reduce((sum, t) => sum + openAnomalies(state, t.id).length, 0),
    [state]
  );
  const plannedCount = state.waterChanges.filter((w) => w.status === "planned").length;

  const selectedRecords = selected ? activeRecords(state, selected.id) : [];
  const selectedOpen = selected ? openAnomalies(state, selected.id) : [];
  const selectedWcs = selected
    ? state.waterChanges.filter((w) => w.tankId === selected.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    : [];
  const recordById = useMemo(() => new Map(state.records.map((r) => [r.id, r])), [state.records]);

  // ---------- 变更操作 ----------

  const submitMeasurement = (payload: MeasurementPayload) => {
    if (!selected || !formMode) return;
    const now = new Date().toISOString();
    const triggered = evaluateValues(payload.values);
    const anomalies: Anomaly[] = triggered.map((t) => ({
      id: uid(),
      metric: t.rule.metric,
      rule: t.rule.describe,
      value: t.value,
      status: "open",
      disposals: [{ id: uid(), text: payload.disposals[t.rule.metric]!.trim(), createdAt: now }],
      createdAt: now,
    }));

    if (formMode.kind === "correct") {
      const origin = formMode.record;
      const rec: Measurement = {
        id: uid(),
        tankId: selected.id,
        kind: origin.kind,
        measuredAt: payload.measuredAt,
        ...payload.values,
        version: origin.version + 1,
        supersedes: origin.id,
        reason: payload.reason,
        anomalies,
        createdAt: now,
      };
      setState((s) => ({ ...s, records: [...s.records, rec] }));
      setMessage(`已保存修正版本 v${rec.version}，原记录保留不可覆盖`);
    } else {
      const rec: Measurement = {
        id: uid(),
        tankId: selected.id,
        kind: "manual",
        measuredAt: payload.measuredAt,
        ...payload.values,
        version: 1,
        supersedes: null,
        reason: null,
        anomalies,
        createdAt: now,
      };
      setState((s) => ({ ...s, records: [...s.records, rec] }));
      setMessage(anomalies.length > 0 ? `已保存，${anomalies.length} 项异常已登记处置，待处理关闭` : "检测记录已保存");
    }
    setFormMode(null);
  };

  const addDisposal = (recordId: string, anomalyId: string, text: string) => {
    const now = new Date().toISOString();
    setState((s) => ({
      ...s,
      records: s.records.map((r) =>
        r.id !== recordId
          ? r
          : {
              ...r,
              anomalies: r.anomalies.map((a) =>
                a.id !== anomalyId ? a : { ...a, disposals: [...a.disposals, { id: uid(), text, createdAt: now }] }
              ),
            }
      ),
    }));
    setMessage("处置动作已登记");
  };

  const closeAnomaly = (recordId: string, anomalyId: string) => {
    const now = new Date().toISOString();
    setState((s) => ({
      ...s,
      records: s.records.map((r) =>
        r.id !== recordId
          ? r
          : {
              ...r,
              anomalies: r.anomalies.map((a) =>
                a.id !== anomalyId || a.disposals.length === 0
                  ? a
                  : { ...a, status: "closed" as const, closedAt: now }
              ),
            }
      ),
    }));
    setMessage("异常已关闭");
  };

  const planWaterChange = (percent: number) => {
    if (!selected) return;
    setState((s) => ({
      ...s,
      waterChanges: [
        ...s.waterChanges,
        { id: uid(), tankId: selected.id, percent, status: "planned", createdAt: new Date().toISOString() },
      ],
    }));
    setMessage(`已登记换水计划 ${percent}%`);
    setFormMode(null);
  };

  const cancelWaterChange = (wcId: string) => {
    setState((s) => ({ ...s, waterChanges: s.waterChanges.filter((w) => w.id !== wcId) }));
    setMessage("换水计划已取消");
  };

  const completeWaterChange = (wc: WaterChange | null, percent: number) => {
    if (!selected) return;
    const open = openAnomalies(state, selected.id);
    if (open.length > 0) {
      setMessage(`异常未关闭（${open.length} 项），禁止记录换水完成`);
      return;
    }
    const base = activeRecords(state, selected.id)[0];
    if (!base) {
      setMessage("需先保存一条检测记录作为回填基准");
      return;
    }
    const now = new Date().toISOString();
    const est = computeEstimate(base, percent);
    const triggered = evaluateValues(est);
    const estRecord: Measurement = {
      id: uid(),
      tankId: selected.id,
      kind: "estimate",
      measuredAt: now,
      ...est,
      version: 1,
      supersedes: null,
      reason: `换水 ${percent}% 回填估算（基于 ${fmtTime(base.measuredAt)} 检测值，补水按 pH 7.0 / 25℃ / 无氨氮硝酸盐）`,
      anomalies: triggered.map((t) => ({
        id: uid(),
        metric: t.rule.metric,
        rule: t.rule.describe,
        value: t.value,
        status: "open" as const,
        disposals: [{ id: uid(), text: `换水 ${percent}% 稀释（系统自动回填）`, createdAt: now }],
        createdAt: now,
      })),
      createdAt: now,
    };
    setState((s) => ({
      ...s,
      records: [...s.records, estRecord],
      waterChanges: wc
        ? s.waterChanges.map((w) =>
            w.id === wc.id
              ? { ...w, status: "completed" as const, completedAt: now, sourceRecordId: base.id, estimateRecordId: estRecord.id }
              : w
          )
        : [
            ...s.waterChanges,
            {
              id: uid(),
              tankId: selected.id,
              percent,
              status: "completed" as const,
              createdAt: now,
              completedAt: now,
              sourceRecordId: base.id,
              estimateRecordId: estRecord.id,
            },
          ],
    }));
    setMessage(
      triggered.length > 0
        ? `换水 ${percent}% 已完成，估算浓度已回填；仍有 ${triggered.length} 项异常待关闭`
        : `换水 ${percent}% 已完成，估算浓度已回填`
    );
    setFormMode(null);
  };

  const addTank = () => {
    const volume = parseFloat(tankDraft.volumeL);
    if (!tankDraft.name.trim()) return setMessage("请填写鱼缸名称");
    if (!Number.isFinite(volume) || volume <= 0) return setMessage("水体体积需为正数");
    const tank: Tank = {
      id: uid(),
      name: tankDraft.name.trim(),
      type: tankDraft.type,
      volumeL: volume,
      createdAt: new Date().toISOString(),
    };
    setState((s) => ({ ...s, tanks: [...s.tanks, tank] }));
    setSelectedId(tank.id);
    setTankDraft({ name: "", type: TANK_TYPES[0], volumeL: "100" });
    setFormMode(null);
    setMessage(`鱼缸「${tank.name}」已创建`);
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `水质追踪-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage("已导出 JSON 文件");
  };

  const importJson = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed: unknown = JSON.parse(String(reader.result));
        if (!isValidState(parsed)) {
          setMessage("导入失败：文件结构不符合鱼缸/检测/换水数据格式");
          return;
        }
        setState(parsed);
        setSelectedId(null);
        setFormMode(null);
        const n = detectConflicts(parsed).length;
        setMessage(n > 0 ? `导入完成，检测到 ${n} 项链上冲突，请查看冲突面板` : "导入完成，链上数据一致");
      } catch {
        setMessage("导入失败：不是有效的 JSON 文件");
      }
    };
    reader.readAsText(file);
  };

  // ---------- 渲染 ----------

  const wcPct = parseFloat(wcPercent);
  const wcValid = Number.isFinite(wcPct) && wcPct > 0 && wcPct <= 100;

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">hxwl-05 · 数据本地落盘 · 记录不可覆盖</p>
          <h1>多鱼缸水质追踪台</h1>
          <p className="subtitle">
            检测时间、pH、氨氮、硝酸盐、温度与换水量全程留痕；触发异常规则须先登记处置动作才能保存，
            异常未关闭禁止记录换水完成；修正只能新建带原因的版本。
          </p>
        </div>
        <div className="stack-card">
          <span>数据操作</span>
          <div className="data-actions">
            <button onClick={exportJson}>导出 JSON</button>
            <button onClick={() => fileRef.current?.click()}>导入 JSON</button>
            <button
              className="danger-action"
              onClick={() => {
                if (window.confirm("重置为示例数据？当前全部记录将被清除。")) {
                  setState(resetState());
                  setSelectedId(null);
                  setFormMode(null);
                  setMessage("已重置为示例数据");
                }
              }}
            >
              重置示例
            </button>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) importJson(f);
              e.target.value = "";
            }}
          />
        </div>
      </section>

      <section className="metrics-grid">
        <article className="metric-card">
          <span>鱼缸总数</span>
          <strong>{state.tanks.length}</strong>
          <i className="status-ok" />
        </article>
        <article className="metric-card">
          <span>未关闭异常</span>
          <strong>{totalOpenAnomalies}</strong>
          <i className={totalOpenAnomalies > 0 ? "status-danger" : "status-ok"} />
        </article>
        <article className="metric-card">
          <span>待完成换水</span>
          <strong>{plannedCount}</strong>
          <i className="status-watch" />
        </article>
        <article className="metric-card">
          <span>链上冲突</span>
          <strong>{conflicts.length}</strong>
          <i className={conflicts.length > 0 ? "status-danger" : "status-ok"} />
        </article>
      </section>

      {message && (
        <p className="message-banner" onClick={() => setMessage("")}>
          {message}
        </p>
      )}

      {conflicts.length > 0 && (
        <section className="panel conflict-panel">
          <div className="section-heading">
            <div>
              <p>一致性检查</p>
              <h2>链上冲突（{conflicts.length}）</h2>
            </div>
          </div>
          <table className="conflict-table">
            <thead>
              <tr>
                <th>鱼缸</th>
                <th>指标</th>
                <th>原值</th>
                <th>新值</th>
                <th>触发规则</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c, i) => (
                <tr key={i}>
                  <td>{c.tank}</td>
                  <td>{c.metric}</td>
                  <td>{c.oldValue}</td>
                  <td>{c.newValue}</td>
                  <td>{c.rule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="workspace">
        <aside className="panel narrow">
          <h2>异常判定规则</h2>
          <ul className="rule-list">
            {RULES.map((r) => (
              <li key={r.metric}>{r.describe}</li>
            ))}
          </ul>
          <p className="muted small">触发任一规则：先登记处置动作才能保存；异常未关闭禁止换水完成。</p>
          <h2>回填模型</h2>
          <p className="muted small">
            换水完成后按换水量比例回填估算浓度：氨氮、硝酸盐按比例稀释；pH 向 7.0、温度向 25℃ 回归（假设补水
            pH 7.0 / 25℃ / 无氨氮硝酸盐）。
          </p>
          <h2>新增鱼缸</h2>
          {formMode?.kind === "tank" ? (
            <div className="tank-form">
              <label>
                <span>名称</span>
                <input
                  value={tankDraft.name}
                  onChange={(e) => setTankDraft((d) => ({ ...d, name: e.target.value }))}
                  placeholder="如：三湖缸D"
                />
              </label>
              <label>
                <span>类型</span>
                <select value={tankDraft.type} onChange={(e) => setTankDraft((d) => ({ ...d, type: e.target.value }))}>
                  {TANK_TYPES.map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>水体（L）</span>
                <input
                  type="number"
                  value={tankDraft.volumeL}
                  onChange={(e) => setTankDraft((d) => ({ ...d, volumeL: e.target.value }))}
                />
              </label>
              <div className="form-actions">
                <button className="primary-action" onClick={addTank}>
                  创建
                </button>
                <button onClick={() => setFormMode(null)}>取消</button>
              </div>
            </div>
          ) : (
            <button className="primary-action wide" onClick={() => setFormMode({ kind: "tank" })}>
              新增鱼缸
            </button>
          )}
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>水族养护</p>
              <h2>鱼缸总览</h2>
            </div>
          </div>
          <div className="tank-grid">
            {state.tanks.map((tank) => {
              const latest = activeRecords(state, tank.id)[0];
              const open = openAnomalies(state, tank.id).length;
              const planned = state.waterChanges.filter((w) => w.tankId === tank.id && w.status === "planned").length;
              const isSelected = selected?.id === tank.id;
              return (
                <article
                  key={tank.id}
                  className={`tank-card ${isSelected ? "tank-selected" : ""}`}
                  onClick={() => {
                    setSelectedId(tank.id);
                    setFormMode(null);
                  }}
                >
                  <div className="tank-head">
                    <h3>{tank.name}</h3>
                    <span className="badge">{tank.type}</span>
                    <span className="muted">{tank.volumeL}L</span>
                  </div>
                  {latest ? (
                    <div className="value-grid compact">
                      {METRIC_ORDER.map((m) => {
                        const rule = RULE_BY_METRIC[m];
                        const abnormal = rule.test(latest[m]);
                        return (
                          <div key={m} className={`value-cell ${abnormal ? "value-abnormal" : ""}`}>
                            <span>{rule.label}</span>
                            <strong>{fmtMetric(m, latest[m])}</strong>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="muted small">暂无检测记录</p>
                  )}
                  <div className="tank-badges">
                    {open > 0 && <span className="badge badge-danger">{open} 项异常未关闭</span>}
                    {planned > 0 && <span className="badge badge-watch">{planned} 项换水计划</span>}
                    {latest && <span className="muted small">最近检测 {fmtTime(latest.measuredAt)}</span>}
                  </div>
                </article>
              );
            })}
          </div>

          {selected && (
            <div className="detail">
              <div className="section-heading">
                <div>
                  <p>当前鱼缸</p>
                  <h2>
                    {selected.name}
                    {selectedOpen.length > 0 && (
                      <span className="badge badge-danger"> {selectedOpen.length} 项异常未关闭</span>
                    )}
                  </h2>
                </div>
                <div className="form-actions">
                  <button className="primary-action" onClick={() => setFormMode({ kind: "create" })}>
                    新增检测
                  </button>
                  <button onClick={() => setFormMode({ kind: "water" })}>登记换水</button>
                </div>
              </div>

              {formMode?.kind === "create" && (
                <MeasurementForm
                  title={`${selected.name} · 新增检测`}
                  initial={{ measuredAt: nowLocalInput(), ph: "", ammonia: "", nitrate: "", temperature: "" }}
                  requireReason={false}
                  onSubmit={submitMeasurement}
                  onCancel={() => setFormMode(null)}
                />
              )}
              {formMode?.kind === "correct" && (
                <MeasurementForm
                  title={`${selected.name} · 修正 v${formMode.record.version}（生成新版本）`}
                  initial={{
                    measuredAt: nowLocalInput(),
                    ph: String(formMode.record.ph),
                    ammonia: String(formMode.record.ammonia),
                    nitrate: String(formMode.record.nitrate),
                    temperature: String(formMode.record.temperature),
                  }}
                  requireReason
                  onSubmit={submitMeasurement}
                  onCancel={() => setFormMode(null)}
                />
              )}
              {formMode?.kind === "water" && (
                <div className="form-panel">
                  <h3>{selected.name} · 登记换水</h3>
                  <div className="field-grid">
                    <label>
                      <span>换水量（占水体比例 %）</span>
                      <input type="number" min="1" max="100" value={wcPercent} onChange={(e) => setWcPercent(e.target.value)} />
                    </label>
                  </div>
                  {selectedOpen.length > 0 && (
                    <p className="form-error">当前有 {selectedOpen.length} 项异常未关闭，禁止记录换水完成，可先登记计划。</p>
                  )}
                  {!wcValid && <p className="form-error">换水量需为 1~100 之间的数字</p>}
                  <div className="form-actions">
                    <button disabled={!wcValid} onClick={() => planWaterChange(wcPct)}>
                      登记计划
                    </button>
                    <button
                      className="primary-action"
                      disabled={!wcValid || selectedOpen.length > 0}
                      title={selectedOpen.length > 0 ? "异常未关闭时禁止记录换水完成" : "立即完成并按比例回填估算浓度"}
                      onClick={() => completeWaterChange(null, wcPct)}
                    >
                      直接完成换水
                    </button>
                    <button onClick={() => setFormMode(null)}>取消</button>
                  </div>
                </div>
              )}

              <h3 className="sub-heading">检测记录链（保存后不可覆盖）</h3>
              <div className="record-list">
                {selectedRecords.length === 0 && <p className="muted">暂无检测记录，点击「新增检测」开始。</p>}
                {selectedRecords.map((rec) => (
                  <RecordItem
                    key={rec.id}
                    rec={rec}
                    allRecords={state.records.filter((r) => r.tankId === selected.id)}
                    isActive
                    onCorrect={(r) => setFormMode({ kind: "correct", record: r })}
                    onAddDisposal={addDisposal}
                    onCloseAnomaly={closeAnomaly}
                  />
                ))}
              </div>

              <h3 className="sub-heading">换水链</h3>
              <div className="record-list">
                {selectedWcs.length === 0 && <p className="muted">暂无换水记录。</p>}
                {selectedWcs.map((w) => {
                  const est = w.estimateRecordId ? recordById.get(w.estimateRecordId) : undefined;
                  const blocked = selectedOpen.length > 0;
                  return (
                    <article key={w.id} className="record-card">
                      <div className="record-index">{w.percent}%</div>
                      <div className="record-body">
                        <div className="record-head">
                          <h3>
                            {w.status === "planned" ? "换水计划" : "换水已完成"}
                            <span className={`badge ${w.status === "planned" ? "badge-watch" : "badge-ok"}`}>
                              {w.status === "planned" ? "待完成" : "已完成"}
                            </span>
                          </h3>
                          <span className="muted">
                            {w.status === "completed" ? `完成于 ${fmtTime(w.completedAt)}` : `登记于 ${fmtTime(w.createdAt)}`}
                          </span>
                        </div>
                        {est && (
                          <p className="reason-line">
                            回填估算：
                            {METRIC_ORDER.map((m) => `${RULE_BY_METRIC[m].label} ${fmtMetric(m, est[m])}`).join(" · ")}
                          </p>
                        )}
                        {w.status === "planned" && (
                          <div className="record-actions">
                            <button
                              className="primary-action"
                              disabled={blocked}
                              title={blocked ? "异常未关闭时禁止记录换水完成" : "完成换水并按比例回填估算浓度"}
                              onClick={() => completeWaterChange(w, w.percent)}
                            >
                              完成换水
                            </button>
                            <button className="ghost" onClick={() => cancelWaterChange(w.id)}>
                              取消计划
                            </button>
                            {blocked && <span className="muted small">异常未关闭，禁止完成</span>}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}
        </section>
      </section>
    </main>
  );
}

export default App;

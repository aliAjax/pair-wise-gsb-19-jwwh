import "./styles.css";

const project = {
  "id": "hxwl-05",
  "port": 5105,
  "title": "水族箱水质监测",
  "subtitle": "多鱼缸水质趋势、换水和异常指标提醒",
  "stack": "React + Vite + TypeScript + CSS",
  "theme": [
    "#0891b2",
    "#16a34a",
    "#f59e0b"
  ],
  "domain": "水族养护",
  "users": [
    "水族店员",
    "玩家",
    "维护师"
  ],
  "metrics": [
    "pH",
    "氨氮",
    "硝酸盐",
    "换水周期"
  ],
  "filters": [
    "草缸",
    "海缸",
    "三湖缸",
    "繁殖缸"
  ],
  "fields": [
    "pH",
    "氨氮",
    "亚硝酸盐",
    "硝酸盐",
    "硬度",
    "温度",
    "换水量"
  ],
  "records": [
    [
      "草缸A",
      "pH 6.8",
      "稳定",
      "硝酸盐18ppm，计划周末换水30%"
    ],
    [
      "海缸B",
      "pH 8.1",
      "关注",
      "钙硬度偏低，需复测"
    ],
    [
      "繁殖缸C",
      "pH 7.2",
      "异常",
      "亚硝酸盐升高，停止投喂"
    ]
  ]
};

const statusColors = ["status-ok", "status-watch", "status-danger"];

function MetricCard({ label, value, index }: { label: string; value: string; index: number }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <i className={statusColors[index % statusColors.length]} />
    </article>
  );
}

function App() {
  const values = project.metrics.map((metric: string, index: number) => {
    const base = [84, 12, 31, 7][index % 4];
    return String(base + index * 3);
  });

  return (
    <main className="app-shell">
      <section className="hero">
        <div>
          <p className="eyebrow">{project.id} · port {project.port}</p>
          <h1>{project.title}</h1>
          <p className="subtitle">{project.subtitle}</p>
        </div>
        <div className="stack-card">
          <span>技术栈</span>
          <strong>{project.stack}</strong>
        </div>
      </section>

      <section className="metrics-grid">
        {project.metrics.map((metric: string, index: number) => (
          <MetricCard key={metric} label={metric} value={values[index]} index={index} />
        ))}
      </section>

      <section className="workspace">
        <aside className="panel narrow">
          <h2>角色</h2>
          <div className="chips">
            {project.users.map((user: string) => (
              <span key={user}>{user}</span>
            ))}
          </div>
          <h2>筛选</h2>
          <div className="chips muted">
            {project.filters.map((filter: string) => (
              <button key={filter}>{filter}</button>
            ))}
          </div>
        </aside>

        <section className="panel">
          <div className="section-heading">
            <div>
              <p>{project.domain}</p>
              <h2>记录字段</h2>
            </div>
            <button className="primary-action">新增记录</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="records panel">
        <div className="section-heading">
          <div>
            <p>示例数据</p>
            <h2>近期记录</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="record-list">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")} className="record-card">
              <div className="record-index">{String(index + 1).padStart(2, "0")}</div>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;

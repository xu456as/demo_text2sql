import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { KnowledgeRecommendations } from "./KnowledgeRecommendationPanel";
import { SparkSQLExplanation } from "./SparkSQLExplanation";
import { SparkSQLFailureNotice } from "./SparkSQLFailureNotice";
import { TransformationQueryField } from "./TransformationQueryField";
import {
  DemoScenarioGrid,
  McpHistoryConversation,
  type McpDemoScenario,
} from "./McpDemo";
import {
  deriveRequestName,
  recommendKnowledge,
  resolveDemoQuerySources,
  type ResolvedRecommendationSources,
} from "./knowledgeRecommendations";

type Space = {
  id: string;
  name: string;
  description: string;
  provider_type: string;
  target_type: string;
};
type Conversation = { id: string; title: string };
type Catalog = {
  name: string;
  schema_name: string;
  tables: Table[];
  relations: { left: string; right: string; description: string }[];
};
type Table = {
  name: string;
  description: string;
  owner: string;
  data_tier: "T1" | "T2" | "T3";
  columns: {
    name: string;
    data_type: string;
    description: string;
    nullable: boolean;
    primary_key: boolean;
  }[];
};
type Semantic = {
  instructions: string[];
  terms: { name: string; definition: string }[];
  metrics: { name: string; expression: string; description: string }[];
  joins: { name: string; expression: string }[];
  examples: { question: string; sql: string; trusted: boolean }[];
};
type Answer = {
  id: string;
  answer: string;
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  chart?: { type: string; x_key: string; y_keys: string[] };
  followups: string[];
  provenance: {
    mode: string;
    source: string;
    trusted: boolean;
    target: string;
  };
  referenced_tables: string[];
  dataset: {
    catalog: string;
    schema: string;
    tables: string[];
    provider: string;
  };
  execution: {
    status: string;
    target: string;
    row_count: number;
    truncated: boolean;
    duration_ms: number;
  };
  visualization: {
    status: string;
    type: string | null;
    x_key: string | null;
    y_keys: string[];
  };
};
type Source = {
  dataset_id: string;
  role: "primary" | "auxiliary";
  alias: string;
  selected_columns: string[];
};
type SparkSQL = {
  content: string;
  version: number;
  generation_source: "mock" | "anthropic" | "manual";
  status?: string;
  explanation?: string;
  sufficiency?: {
    sufficient: boolean;
    missing_information: string[];
    assumptions: string[];
  };
  validation?: {
    status: string;
    errors: string[];
    warnings: string[];
    referenced_tables: string[];
    output_columns: string[];
    joins: string[];
  };
  stages?: { name: string; status: string; message: string }[];
  provider?: {
    name: string;
    model: string;
    latency_ms: number;
    input_tokens?: number;
    output_tokens?: number;
  };
  raw_response?: string;
};
type Sink = {
  catalog: string;
  database: string;
  table: string;
  write_mode: "append" | "overwrite";
  partition_columns: string[];
  description: string;
};
type TransformRequest = {
  id: string;
  name: string;
  status: "waiting_submit" | "waiting_approval" | "success" | "failed";
  stage: string;
  version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
  snapshot: {
    name: string;
    requirement_text: string;
    source: Source[];
    spark_sql: SparkSQL;
    sink: Sink;
    validation: {
      status: string;
      referenced_tables: string[];
      output_columns: string[];
      joins: string[];
      warnings: string[];
      errors: string[];
    };
    runner: { type: string; status: string };
  };
};

const statusLabel: Record<string, string> = {
  waiting_submit: "Waiting to Submit",
  waiting_approval: "Waiting for Approval",
  success: "Success",
  failed: "Failed",
};

function Panel({ title, children }: { title: string; children: any }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
function GenerationHeader() {
  const [mode, setMode] = useState<"mock" | "llm">(() =>
      sessionStorage.getItem("datachat_generation_mode") === "llm"
        ? "llm"
        : "mock",
    ),
    [capability, setCapability] = useState<{
      configured: boolean;
      model: string | null;
    }>({ configured: false, model: null }),
    [result, setResult] = useState<SparkSQL | null>(null);
  useEffect(() => {
    api<{ anthropic: { configured: boolean; model: string | null } }>(
      "/capabilities",
    ).then((x) => setCapability(x.anthropic));
    const listener = (event: Event) =>
      setResult((event as CustomEvent<SparkSQL>).detail);
    window.addEventListener("spark-generation-result", listener);
    return () =>
      window.removeEventListener("spark-generation-result", listener);
  }, []);
  function choose(value: "mock" | "llm") {
    sessionStorage.setItem("datachat_generation_mode", value);
    setMode(value);
  }
  return (
    <div className="generation-header">
      <div className="generation-mode">
        <small>Generation Mode</small>
        <button
          className={mode === "mock" ? "active" : ""}
          onClick={() => choose("mock")}
        >
          Mock
        </button>
        <button
          className={mode === "llm" ? "active" : ""}
          disabled={!capability.configured}
          title={
            capability.configured
              ? "Use Anthropic"
              : "Configure ANTHROPIC_API_KEY and ANTHROPIC_MODEL"
          }
          onClick={() => choose("llm")}
        >
          Real LLM
        </button>
      </div>
      {result && (
        <div className="llm-result">
          <div className="llm-result-head">
            <b>
              {result.generation_source === "anthropic" ? "ANTHROPIC" : "MOCK"}{" "}
              RESULT
            </b>
            <span>
              {result.provider?.model}
              {result.provider?.latency_ms
                ? ` · ${result.provider.latency_ms} ms`
                : ""}
            </span>
          </div>
          <div className="llm-result-grid">
            <span>
              <small>Source sufficiency</small>
              <b>
                {result.sufficiency?.sufficient ? "Sufficient" : "Insufficient"}
              </b>
            </span>
            <span>
              <small>Validation</small>
              <b>{result.validation?.status || result.status}</b>
            </span>
            <span>
              <small>Tokens</small>
              <b>
                {result.provider?.input_tokens ?? "—"} in /{" "}
                {result.provider?.output_tokens ?? "—"} out
              </b>
            </span>
          </div>
          {result.sufficiency?.assumptions?.length ? (
            <div className="generation-notice">
              <b>Assumptions</b>
              {result.sufficiency.assumptions.map((x) => (
                <p key={x}>{x}</p>
              ))}
            </div>
          ) : null}
          {result.sufficiency?.missing_information?.length ? (
            <div className="generation-notice error">
              <b>Missing information</b>
              {result.sufficiency.missing_information.map((x) => (
                <p key={x}>{x}</p>
              ))}
            </div>
          ) : null}
          {result.validation?.errors?.length ? (
            <div className="generation-notice error">
              <b>Validation errors</b>
              {result.validation.errors.map((x) => (
                <p key={x}>{x}</p>
              ))}
            </div>
          ) : null}
          {result.raw_response && (
            <details>
              <summary>View Raw LLM Response</summary>
              <pre>{result.raw_response}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
function Title({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="page-title">
      <div className="page-title-row">
        <h1>{title}</h1>
        {title === "Data Transformation" && <GenerationHeader />}
      </div>
      <p>{sub}</p>
    </div>
  );
}
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}
function Field({
  label,
  value,
  set,
}: {
  label: string;
  value: string;
  set: (v: string) => void;
}) {
  return (
    <label className="field">
      {label}
      <input value={value} onChange={(e) => set(e.target.value)} />
    </label>
  );
}
function Status({ value }: { value: string }) {
  return (
    <span className={`task-status ${value}`}>
      {statusLabel[value] || value}
    </span>
  );
}
function Option({
  active,
  title,
  desc,
}: {
  active?: boolean;
  title: string;
  desc: string;
}) {
  return (
    <div className={`option ${active ? "active" : ""}`}>
      <span>{active ? "✓" : "○"}</span>
      <div>
        <b>{title}</b>
        <p>{desc}</p>
      </div>
    </div>
  );
}
function Stat({ n, label, warn }: { n: any; label: string; warn?: boolean }) {
  return (
    <div className={`stat ${warn ? "warn" : ""}`}>
      <b>{n}</b>
      <span>{label}</span>
    </div>
  );
}
function ResultTable({
  columns,
  rows,
}: {
  columns: string[];
  rows: Record<string, unknown>[];
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((r, i) => (
            <tr key={i}>
              {columns.map((c) => (
                <td key={c}>
                  {typeof r[c] === "number"
                    ? Number(r[c]).toLocaleString()
                    : String(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function MiniChart({ answer }: { answer: Answer }) {
  if (!answer.chart || !answer.rows.length) return null;
  const key = answer.chart.y_keys[0],
    values = answer.rows.map((r) => Number(r[key]) || 0),
    max = Math.max(...values, 1);
  return (
    <div className="chart">
      <div className="chart-title">
        Trend overview <span>Auto-selected</span>
      </div>
      <div className="bars">
        {answer.rows.map((row, i) => (
          <div className="bar-wrap" key={i}>
            <div className="bar-value">{Math.round(values[i] / 1000)}k</div>
            <div
              className="bar"
              style={{ height: `${Math.max(8, (values[i] / max) * 120)}px` }}
            />
            <small>
              {String(row[answer.chart!.x_key]).replace("2026-", "")}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}
function FlowStep({
  number,
  title,
  status,
  children,
}: {
  number: string;
  title: string;
  status: string;
  children: any;
}) {
  return (
    <section className="flow-step">
      <div className="flow-marker">
        <b>{number}</b>
        <i />
      </div>
      <div className="flow-content">
        <header>
          <h4>{title}</h4>
          <span>✓ {status}</span>
        </header>
        {children}
      </div>
    </section>
  );
}
function QueryFlow({ answer }: { answer: Answer }) {
  const source =
    { trusted: "Trusted example", mock: "Mock generated", ai: "LLM generated" }[
      answer.provenance.source
    ] || answer.provenance.source;
  return (
    <div className="query-flow">
      <div className="flow-heading">
        <b>Query execution flow</b>
        <span>Dataset, SQL, execution, and visualization stay visible</span>
      </div>
      <FlowStep number="1" title="Select Dataset" status="Selected">
        <div className="dataset-card">
          <div>
            <small>Catalog / Schema</small>
            <b>
              {answer.dataset.catalog} <em>/ {answer.dataset.schema}</em>
            </b>
          </div>
          <div>
            <small>Referenced tables</small>
            <p>
              {answer.dataset.tables.map((t) => (
                <code key={t}>▦ {t}</code>
              ))}
            </p>
          </div>
          <span className="source-tag">
            {answer.dataset.provider.toUpperCase()} PROVIDER
          </span>
        </div>
      </FlowStep>
      <FlowStep
        number="2"
        title="Generate SQL"
        status="Generated and validated"
      >
        <div className="sql-meta">
          <span>
            Source <b>{source}</b>
          </span>
          <span>
            Guardrails <b>Read only · Single statement · Allowlist · LIMIT</b>
          </span>
        </div>
        <pre className="sql-code">
          <code>{answer.sql}</code>
        </pre>
      </FlowStep>
      <FlowStep number="3" title="Execute SQL" status="Succeeded">
        <div className="execution-summary">
          <Metric
            label="Target"
            value={answer.execution.target.toUpperCase()}
          />
          <Metric label="Rows" value={`${answer.execution.row_count}`} />
          <Metric
            label="Duration"
            value={`${answer.execution.duration_ms} ms`}
          />
          <Metric
            label="Result limit"
            value={answer.execution.truncated ? "Truncated" : "Not truncated"}
          />
        </div>
        <ResultTable columns={answer.columns} rows={answer.rows} />
      </FlowStep>
      <FlowStep
        number="4"
        title="Create Visualization"
        status={
          answer.visualization.status === "rendered" ? "Rendered" : "Table only"
        }
      >
        <div className="viz-meta">
          {answer.visualization.status === "rendered" ? (
            <>
              <span>
                Chart <b>{answer.visualization.type}</b>
              </span>
              <span>
                X axis <b>{answer.visualization.x_key}</b>
              </span>
              <span>
                Y axis <b>{answer.visualization.y_keys.join(", ")}</b>
              </span>
            </>
          ) : (
            <span>This result is better represented as a table.</span>
          )}
        </div>
        <MiniChart answer={answer} />
      </FlowStep>
    </div>
  );
}
function DatasetDetails({
  table,
  schema,
  onClose,
}: {
  table: Table;
  schema: string;
  onClose: () => void;
}) {
  const tierLabel = {
    T1: "Raw data",
    T2: "Cleaned data",
    T3: "Aggregated data",
  }[table.data_tier];
  function close(e: React.MouseEvent) {
    e.stopPropagation();
    onClose();
  }
  return (
    <div className="source-modal-backdrop" onClick={close}>
      <div
        className="dataset-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`${table.name} dataset details`}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <span className="table-icon">▦</span>
            <div>
              <h2>{table.name}</h2>
              <p>{table.description}</p>
            </div>
          </div>
          <button aria-label="Close" onClick={close}>
            ×
          </button>
        </header>
        <div className="dataset-detail-summary">
          <Metric label="Table" value={table.name} />
          <Metric label="Schema" value={schema} />
          <Metric label="Owner" value={table.owner} />
          <div>
            <small>Data Type</small>
            <b>
              <span className={`tier-badge ${table.data_tier.toLowerCase()}`}>
                {table.data_tier}
              </span>{" "}
              {tierLabel}
            </b>
          </div>
        </div>
        <section>
          <h3>
            Column definitions <span>{table.columns.length} columns</span>
          </h3>
          <div className="detail-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Column</th>
                  <th>Data type</th>
                  <th>Description</th>
                  <th>Nullable</th>
                  <th>Key</th>
                </tr>
              </thead>
              <tbody>
                {table.columns.map((column) => (
                  <tr key={column.name}>
                    <td>
                      <code>{column.name}</code>
                    </td>
                    <td>
                      <span className="column-type">{column.data_type}</span>
                    </td>
                    <td>{column.description}</td>
                    <td>{column.nullable ? "Yes" : "No"}</td>
                    <td>{column.primary_key ? "Primary" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
function AnswerCard({
  answer,
  onFollow,
}: {
  answer: Answer;
  onFollow: (q: string) => void;
}) {
  const [sent, setSent] = useState("");
  async function feedback(rating: string) {
    await api(`/messages/${answer.id}/feedback`, {
      method: "POST",
      body: JSON.stringify({
        rating,
        comment:
          rating === "negative" ? "Please review the business definition." : "",
      }),
    });
    setSent(rating);
  }
  return (
    <div className="answer-card">
      <div className="answer-meta">
        <span
          className={answer.provenance.trusted ? "badge trusted" : "badge mock"}
        >
          {answer.provenance.trusted ? "✓ Verified" : "◈ Demo data"}
        </span>
        <span>Using {answer.referenced_tables.join(", ")}</span>
      </div>
      <h3>{answer.answer}</h3>
      <QueryFlow answer={answer} />
      <div className="answer-actions">
        <span>Was this answer helpful?</span>
        <button
          className={sent === "positive" ? "selected" : ""}
          onClick={() => feedback("positive")}
        >
          👍
        </button>
        <button
          className={sent === "negative" ? "selected" : ""}
          onClick={() => feedback("negative")}
        >
          👎
        </button>
        <button onClick={() => feedback("review")}>Request review</button>
      </div>
      <div className="followups">
        {answer.followups.map((q) => (
          <button onClick={() => onFollow(q)} key={q}>
            {q} <span>→</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function Chat({ space }: { space: Space }) {
  const [conversation, setConversation] = useState<Conversation | null>(null),
    [question, setQuestion] = useState(""),
    [messages, setMessages] = useState<{ q: string; a: Answer }[]>([]),
    [activeConversation, setActiveConversation] = useState<"sales" | "pipeline">("sales"),
    [loading, setLoading] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    api<Conversation>("/conversations", {
      method: "POST",
      body: JSON.stringify({
        space_id: space.id,
        title: "Sales trend exploration",
      }),
    }).then(setConversation);
  }, [space.id]);
  async function ask(value?: string) {
    const q = (value ?? question).trim();
    if (!q || !conversation) return;
    setQuestion("");
    setActiveConversation("sales");
    setLoading(true);
    setError("");
    try {
      const a = await api<Answer>(
        `/conversations/${conversation.id}/messages`,
        { method: "POST", body: JSON.stringify({ content: q }) },
      );
      setMessages((v) => [...v, { q, a }]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  function openScenario(scenario: McpDemoScenario) {
    if (scenario.mode === "history") {
      setMessages([]);
      setActiveConversation("pipeline");
      return;
    }
    ask(scenario.prompt);
  }
  function newConversation() {
    setMessages([]);
    setQuestion("");
    setError("");
    setActiveConversation("sales");
  }
  return (
    <main className="chat-layout">
      <aside className="chat-list">
        <button className="new-chat" onClick={newConversation}>＋ New conversation</button>
        <p>Recent conversations</p>
        <button className={`conversation ${activeConversation === "sales" ? "active" : ""}`} onClick={newConversation}>
          Sales trend exploration
          <br />
          <small>Just now</small>
        </button>
        <button className={`conversation ${activeConversation === "pipeline" ? "active" : ""}`} onClick={() => { setMessages([]); setActiveConversation("pipeline"); }}>
          Build monthly sales pipeline
          <br />
          <small>2 hours ago · 6 MCPs</small>
        </button>
      </aside>
      <section className="chat-main">
        <header>
          <div>
            <h2>{space.name}</h2>
            <p>
              <i /> Connected ·{" "}
              {space.target_type === "mock"
                ? "Mock demo data"
                : space.target_type}
            </p>
          </div>
          <span className="badge mock">DEMO MODE</span>
        </header>
        <div className="messages">
          {!messages.length && activeConversation === "sales" && (
            <div className="hero">
              <div className="spark">✦</div>
              <h1>What would you like to know?</h1>
              <p>
                Ask in natural language. DataChat will query authorized data and
                explain the result.
              </p>
              <DemoScenarioGrid onSelect={openScenario} />
            </div>
          )}
          {!messages.length && activeConversation === "pipeline" && <McpHistoryConversation />}
          {messages.map((m, i) => (
            <div key={i}>
              <div className="user-message">{m.q}</div>
              <AnswerCard answer={m.a} onFollow={ask} />
            </div>
          ))}
          {loading && (
            <div className="thinking">
              <span /> Selecting context, generating SQL, and validating the
              query…
            </div>
          )}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="composer">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask();
              }
            }}
            placeholder="Ask your data…"
          />
          <button onClick={() => ask()}>↑</button>
          <small>
            AI-generated results may be inaccurate. Verify critical business
            decisions.
          </small>
        </div>
      </section>
    </main>
  );
}

function TransformationBuilder({
  space,
  onCreated,
}: {
  space: Space;
  onCreated: (id: string) => void;
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [primary, setPrimary] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailTable, setDetailTable] = useState<Table | null>(null);
  const [requirement, setRequirement] = useState("");
  const skipNextExampleSourceSync = useRef(false);
  const [sql, setSql] = useState<SparkSQL | null>(null);
  const [sink, setSink] = useState<Sink>({
    catalog: "analytics",
    database: "sales",
    table: "monthly_region_sales",
    write_mode: "overwrite",
    partition_columns: ["month"],
    description: "Monthly regional sales aggregate",
  });
  const name = deriveRequestName(requirement);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    api<Catalog>(`/spaces/${space.id}/metadata`).then(setCatalog);
  }, [space.id]);
  useEffect(() => {
    if (!catalog) return;
    const resolved = resolveDemoQuerySources(
      requirement,
      catalog.tables.map((table) => table.name),
    );
    if (!resolved) return;
    if (skipNextExampleSourceSync.current) {
      skipNextExampleSourceSync.current = false;
      return;
    }
    setSelected(resolved.selected);
    setPrimary(resolved.primary);
    setSql(null);
    setError("");
  }, [requirement, catalog]);
  const sources = useMemo<Source[]>(
    () =>
      selected.map((table, index) => {
        const meta = catalog?.tables.find((t) => t.name === table);
        return {
          dataset_id: `${catalog?.schema_name || "demo_sales"}.${table}`,
          role: table === primary ? "primary" : "auxiliary",
          alias: index === 0 ? "o" : String.fromCharCode(99 + index - 1),
          selected_columns: meta?.columns.map((c) => c.name) || [],
        };
      }),
    [selected, primary, catalog],
  );
  const available =
    catalog?.tables.filter((table) => !selected.includes(table.name)) || [];
  const recommendations = useMemo(
    () => recommendKnowledge(requirement),
    [requirement],
  );
  function addSource(table: string) {
    setSelected((v) => [...v, table]);
    setSql(null);
    setPickerOpen(false);
  }
  function removeSource(table: string) {
    setSelected((v) => v.filter((x) => x !== table));
    if (primary === table) setPrimary("");
    setSql(null);
    setTimeout(() => setDetailTable(null), 0);
  }
  function useRecommendedSources(resolved: ResolvedRecommendationSources) {
    setSelected(resolved.selected);
    setPrimary(resolved.primary);
    setSql(null);
    setError("");
  }
  function useExampleForRecommendations(example: string) {
    if (example === requirement) return;
    skipNextExampleSourceSync.current = true;
    setRequirement(example);
  }
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const mode =
        sessionStorage.getItem("datachat_generation_mode") === "llm"
          ? "llm"
          : "mock";
      const response = await api<SparkSQL>("/transformation-sql/generate", {
        method: "POST",
        body: JSON.stringify({
          mode,
          source: sources,
          requirement_text: requirement,
          sink,
          previous_attempt: sql?.content
            ? {
                sql: sql.content,
                validation_errors: sql.validation?.errors || [],
              }
            : null,
        }),
      });
      const result = { ...response, content: response.content || "" };
      setSql(result);
      window.dispatchEvent(
        new CustomEvent("spark-generation-result", { detail: result }),
      );
    } catch (e) {
      const message = (e as Error).message;
      setError(message);
      const failureResult: SparkSQL = {
        content: "",
        version: 1,
        generation_source: "anthropic",
        status: "failed",
        explanation: message,
        sufficiency: {
          sufficient: false,
          missing_information: [],
          assumptions: [],
        },
      };
      setSql(failureResult);
      window.dispatchEvent(
        new CustomEvent("spark-generation-result", {
          detail: failureResult,
        }),
      );
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    if (!sql) return;
    setBusy(true);
    setError("");
    try {
      const created = await api<TransformRequest>("/transformation-requests", {
        method: "POST",
        body: JSON.stringify({
          name,
          requirement_text: requirement,
          source: sources,
          spark_sql: sql,
          sink,
        }),
      });
      onCreated(created.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const ready =
    selected.length > 0 &&
    !!primary &&
    !!sql?.content &&
    sql.validation?.status !== "failed" &&
    !!sink.catalog &&
    !!sink.database &&
    !!sink.table;
  return (
    <div className="admin-page transformation-page">
      <Title
        title="Data Transformation"
        sub="Package Source datasets, generated Spark SQL, and a Sink dataset into a submit-ready request."
      />
      <div className="builder-progress">
        <span className={requirement ? "done" : ""}>
          1 <b>Requirement</b>
        </span>
        <i />
        <span className={selected.length ? "done" : ""}>
          2 <b>Source Data</b>
        </span>
        <i />
        <span className={sql?.status === "generated" && sql.content ? "done" : ""}>
          3 <b>Spark SQL</b>
        </span>
        <i />
        <span className={ready ? "done" : ""}>
          4 <b>Sink Dataset</b>
        </span>
      </div>
      <div className="builder-grid">
        <div>
          <Panel title="1 · Transformation Requirement">
            <TransformationQueryField
              value={requirement}
              onChange={setRequirement}
              onUseExample={useExampleForRecommendations}
            />
            <KnowledgeRecommendations
              query={requirement}
              items={recommendations}
              availableTables={catalog?.tables.map((table) => table.name) || []}
              onUseSources={useRecommendedSources}
            />
          </Panel>
          <Panel title="2 · Source Data">
            <div className="source-section-head">
              <p className="section-help">
                Add input datasets and designate exactly one primary dataset.
              </p>
              <button
                className="add-source-button"
                onClick={() => setPickerOpen(true)}
              >
                ＋ Add
              </button>
            </div>
            {pickerOpen && (
              <div
                className="source-modal-backdrop"
                onClick={() => setPickerOpen(false)}
              >
                <div
                  className="source-picker"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Add source dataset"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="source-picker-title">
                    <div>
                      <b>Add source dataset</b>
                      <small>
                        Select one dataset to add to this transformation.
                      </small>
                    </div>
                    <button
                      aria-label="Close"
                      onClick={() => setPickerOpen(false)}
                    >
                      ×
                    </button>
                  </div>
                  <div className="source-option-list">
                    {available.map((table) => (
                      <button
                        className="source-option"
                        key={table.name}
                        onClick={() => addSource(table.name)}
                      >
                        <span>
                          <b>{table.name}</b>
                          <small>{table.description}</small>
                        </span>
                        <em>
                          {table.owner} · {table.columns.length} columns
                        </em>
                        <strong>＋ Add</strong>
                      </button>
                    ))}
                    {!available.length && (
                      <div className="source-picker-empty">
                        All datasets have been added.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
            <div className="selected-source-list">
              {selected.map((tableName) => {
                const table = catalog?.tables.find(
                  (item) => item.name === tableName,
                );
                if (!table) return null;
                return (
                  <div
                    className="source-card compact"
                    key={table.name}
                    role="button"
                    tabIndex={0}
                    onClick={() => setDetailTable(table)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ")
                        setDetailTable(table);
                    }}
                  >
                    <span className="table-icon">▦</span>
                    <div className="source-identity">
                      <b>{table.name}</b>
                      <small>{table.description}</small>
                    </div>
                    <div className="source-inline-meta">
                      <span>
                        <small>Owner</small>
                        {table.owner}
                      </span>
                      <span>
                        <small>Schema</small>
                        {catalog?.schema_name}
                      </span>
                      <span>
                        <small>Data Type</small>
                        {table.data_tier}
                      </span>
                      <span>
                        <small>Columns</small>
                        {table.columns.length}
                      </span>
                    </div>
                    <span
                      className={`source-role-pill ${primary === table.name ? "primary" : ""}`}
                    >
                      {primary === table.name ? "Primary" : "Auxiliary"}
                    </span>
                    <div
                      className="source-card-actions"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {primary !== table.name && (
                        <button
                          onClick={() => {
                            setPrimary(table.name);
                            setSql(null);
                          }}
                        >
                          Set as Primary
                        </button>
                      )}
                      <button
                        className="remove-source"
                        onClick={() => removeSource(table.name)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                );
              })}
              {!selected.length && (
                <div className="source-empty">
                  No source datasets added yet. Use + Add to select one.
                </div>
              )}
            </div>
            <button
              className="primary-button"
              disabled={busy || selected.length === 0 || !primary}
              onClick={generate}
            >
              {busy ? "Generating…" : "✦ Generate Spark SQL"}
            </button>
          </Panel>
        </div>
        <div>
          <Panel title="3 · Generated Spark SQL">
            <div className="stage-meta">
              <span className="badge mock">
                {sql?.generation_source?.toUpperCase() || "NOT GENERATED"}
              </span>
              <span>{selected.length} source datasets</span>
            </div>
            {sql?.status === "insufficient_context" || sql?.status === "failed" ? (
              <SparkSQLFailureNotice
                status={sql.status}
                explanation={sql.explanation}
                missingInformation={sql.sufficiency?.missing_information || []}
                validationErrors={sql.validation?.errors || []}
                busy={busy}
                onRetry={generate}
              />
            ) : sql?.content ? (
              <textarea
                className="sql-editor"
                value={sql.content}
                onChange={(e) =>
                  setSql({
                    ...sql,
                    content: e.target.value,
                    generation_source: "manual",
                  })
                }
              />
            ) : (
              <div className="sql-empty">
                Choose sources and describe the transformation, then generate
                Spark SQL.
              </div>
            )}
            {sql?.status !== "insufficient_context" && sql?.status !== "failed" && (
              <>
                <SparkSQLExplanation
                  generationSource={sql?.generation_source}
                  status={sql?.status}
                  explanation={sql?.explanation}
                />
                <div className="validation-strip">
                  <span>{sql?.content ? "✓ SELECT-only query" : "○ SQL required"}</span>
                  <span>
                    {sql?.content
                      ? "✓ Selected sources only"
                      : "○ Source validation pending"}
                  </span>
                  <span>
                    {sql?.content ? "✓ Output columns detected" : "○ Output schema pending"}
                  </span>
                </div>
              </>
            )}
          </Panel>
          <Panel title="4 · Sink Dataset">
            <div className="form-row three">
              <Field
                label="Catalog"
                value={sink.catalog}
                set={(v) => setSink({ ...sink, catalog: v })}
              />
              <Field
                label="Database"
                value={sink.database}
                set={(v) => setSink({ ...sink, database: v })}
              />
              <Field
                label="Table"
                value={sink.table}
                set={(v) => setSink({ ...sink, table: v })}
              />
            </div>
            <div className="form-row">
              <label className="field">
                Write mode
                <select
                  value={sink.write_mode}
                  onChange={(e) =>
                    setSink({
                      ...sink,
                      write_mode: e.target.value as Sink["write_mode"],
                    })
                  }
                >
                  <option value="overwrite">Overwrite</option>
                  <option value="append">Append</option>
                </select>
              </label>
              <Field
                label="Partition columns"
                value={sink.partition_columns.join(", ")}
                set={(v) =>
                  setSink({
                    ...sink,
                    partition_columns: v
                      .split(",")
                      .map((x) => x.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>
            <label className="field">
              Description
              <input
                value={sink.description}
                onChange={(e) =>
                  setSink({ ...sink, description: e.target.value })
                }
              />
            </label>
            <div className="sink-preview">
              <small>Fully qualified Sink</small>
              <b>
                {sink.catalog}.{sink.database}.{sink.table}
              </b>
            </div>
          </Panel>
        </div>
      </div>
      {detailTable && (
        <DatasetDetails
          table={detailTable}
          schema={catalog?.schema_name || ""}
          onClose={() => setDetailTable(null)}
        />
      )}{" "}
      {error && <div className="error">{error}</div>}
      <div className="ready-bar">
        <div>
          <b>
            {ready ? "Request definition is ready" : "Complete all four stages"}
          </b>
          <span>
            {ready
              ? "SparkJobRunner will remain unconfigured until a runner is connected."
              : "Source, Spark SQL, and Sink are required."}
          </span>
        </div>
        <button
          className="primary-button"
          disabled={!ready || busy}
          onClick={create}
        >
          Create Request →
        </button>
      </div>
    </div>
  );
}

type SpecialistAgent = {
  id: string;
  name: string;
  summary: string;
  domain: string;
  status: "Active" | "Beta" | "Idle";
  requestsHandled: number;
  accuracy: number;
  lastActive: string;
};
type SpecialistTeam = { team: string; agents: SpecialistAgent[] };

const SPECIALIST_TEAMS: SpecialistTeam[] = [
  {
    team: "Data Team Specialists",
    agents: [
      { id: "business-a", name: "Business-A agent", summary: "Explores sales and order analytics with natural-language questions.", domain: "Sales Analytics", status: "Active", requestsHandled: 1284, accuracy: 96, lastActive: "2h ago" },
      { id: "business-b", name: "Business-B agent", summary: "Builds customer segmentation and retention datasets.", domain: "Customer Insight", status: "Active", requestsHandled: 842, accuracy: 94, lastActive: "1d ago" },
      { id: "business-c", name: "Business-C agent", summary: "Assembles regional and product-level reporting layers.", domain: "Reporting", status: "Beta", requestsHandled: 317, accuracy: 91, lastActive: "3h ago" },
    ],
  },
  {
    team: "WMT Team Specialists",
    agents: [
      { id: "business-d", name: "Business-D agent", summary: "Reconciles warehouse movement and inventory positions.", domain: "Warehouse", status: "Active", requestsHandled: 976, accuracy: 93, lastActive: "5h ago" },
      { id: "business-e", name: "Business-E agent", summary: "Tracks fulfillment SLAs and shipment exceptions.", domain: "Fulfillment", status: "Active", requestsHandled: 611, accuracy: 92, lastActive: "20m ago" },
      { id: "business-f", name: "Business-F agent", summary: "Forecasts replenishment demand from historical trends.", domain: "Forecasting", status: "Idle", requestsHandled: 208, accuracy: 88, lastActive: "6d ago" },
    ],
  },
  {
    team: "IBG Team Specialists",
    agents: [
      { id: "business-h", name: "Business-H agent", summary: "Monitors cross-border transaction flows and settlement.", domain: "Payments", status: "Active", requestsHandled: 1043, accuracy: 95, lastActive: "45m ago" },
      { id: "business-i", name: "Business-I agent", summary: "Screens counterparties against compliance watchlists.", domain: "Compliance", status: "Beta", requestsHandled: 289, accuracy: 90, lastActive: "2d ago" },
      { id: "business-j", name: "Business-J agent", summary: "Aggregates portfolio exposure across banking books.", domain: "Risk", status: "Active", requestsHandled: 754, accuracy: 93, lastActive: "8h ago" },
    ],
  },
];

function SpecialistAgentCard({
  agent,
  open,
  onToggle,
}: {
  agent: SpecialistAgent;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className={`agent-card${open ? " open" : ""}`}
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${agent.name}`}
    >
      <div className="agent-card-top">
        <b>{agent.name}</b>
        <span className={`agent-status ${agent.status.toLowerCase()}`}>
          {agent.status}
        </span>
      </div>
      {open ? (
        <div className="agent-overview">
          <div>
            <small>Domain</small>
            <b>{agent.domain}</b>
          </div>
          <div>
            <small>Requests handled</small>
            <b>{agent.requestsHandled.toLocaleString()}</b>
          </div>
          <div>
            <small>Accuracy</small>
            <b>{agent.accuracy}%</b>
          </div>
          <div>
            <small>Last active</small>
            <b>{agent.lastActive}</b>
          </div>
        </div>
      ) : (
        <p>{agent.summary}</p>
      )}
    </button>
  );
}

function SpecialistAgents() {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <div className="admin-page">
      <Title
        title="Specialist Agents"
        sub="Each team maintains its own specialist agents. Select a card to reveal its overview."
      />
      {SPECIALIST_TEAMS.map((group) => (
        <div className="panel" key={group.team}>
          <h3>{group.team}</h3>
          <div className="agent-grid">
            {group.agents.map((agent) => (
              <SpecialistAgentCard
                key={agent.id}
                agent={agent}
                open={openId === agent.id}
                onToggle={() =>
                  setOpenId((current) =>
                    current === agent.id ? null : agent.id,
                  )
                }
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TaskCenter({ focusId }: { focusId?: string }) {
  const [tasks, setTasks] = useState<TransformRequest[]>([]),
    [selected, setSelected] = useState<string | undefined>(focusId),
    [filter, setFilter] = useState("all"),
    [query, setQuery] = useState("");
  async function load() {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("status", filter);
    if (query) params.set("query", query);
    setTasks(
      await api<TransformRequest[]>(`/transformation-requests?${params}`),
    );
  }
  useEffect(() => {
    load();
  }, [filter, query]);
  useEffect(() => {
    if (focusId) setSelected(focusId);
  }, [focusId]);
  const detail = tasks.find((t) => t.id === selected) || tasks[0];
  async function action(name: string) {
    if (!detail) return;
    const updated = await api<TransformRequest>(
      `/transformation-requests/${detail.id}/${name}`,
      { method: "POST" },
    );
    await load();
    setSelected(updated.id);
  }
  return (
    <div className="admin-page task-page">
      <Title
        title="Task Center"
        sub="Review every Source / Spark SQL / Sink request and move it through the submission lifecycle."
      />
      <div className="task-toolbar">
        <input
          placeholder="Search request, source, or sink…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div>
          {[
            "all",
            "waiting_submit",
            "waiting_approval",
            "success",
            "failed",
          ].map((s) => (
            <button
              className={filter === s ? "active" : ""}
              onClick={() => setFilter(s)}
              key={s}
            >
              {s === "all" ? "All" : statusLabel[s]}
            </button>
          ))}
        </div>
      </div>
      <div className="task-layout">
        <Panel title={`${tasks.length} Requests`}>
          <div className="task-list">
            {tasks.map((task) => (
              <button
                className={detail?.id === task.id ? "active" : ""}
                onClick={() => setSelected(task.id)}
                key={task.id}
              >
                <div>
                  <b>{task.name}</b>
                  <small>
                    {task.id} · {task.snapshot.source.length} sources
                  </small>
                </div>
                <Status value={task.status} />
                <span>
                  {task.snapshot.sink.catalog}.{task.snapshot.sink.database}.
                  {task.snapshot.sink.table}
                </span>
              </button>
            ))}
            {!tasks.length && (
              <div className="empty">
                No transformation requests match this filter.
              </div>
            )}
          </div>
        </Panel>
        {detail ? (
          <TaskDetail task={detail} action={action} />
        ) : (
          <Panel title="Request detail">
            <div className="empty">
              Create a transformation request to see its snapshot.
            </div>
          </Panel>
        )}
      </div>
    </div>
  );
}
function TaskDetail({
  task,
  action,
}: {
  task: TransformRequest;
  action: (name: string) => void;
}) {
  const steps = [
    ["waiting_submit", "Request created"],
    ["waiting_approval", "Submitted for approval"],
    ["success", "Runner completed"],
  ];
  return (
    <div className="task-detail">
      <div className="detail-head">
        <div>
          <small>
            {task.id} · Version {task.version}
          </small>
          <h2>{task.name}</h2>
          <p>Created by {task.created_by}</p>
        </div>
        <Status value={task.status} />
      </div>
      <div className="timeline">
        {steps.map(([s, label], i) => (
          <div
            className={
              task.status === s ||
              i < steps.findIndex((x) => x[0] === task.status)
                ? "complete"
                : ""
            }
            key={s}
          >
            <i />
            {label}
          </div>
        ))}
      </div>
      <Panel title="Source Snapshot">
        {task.snapshot.source.map((source) => (
          <div className="snapshot-row" key={source.dataset_id}>
            <span className={`source-role ${source.role}`}>{source.role}</span>
            <b>{source.dataset_id}</b>
            <small>
              alias {source.alias} · {source.selected_columns.length} columns
            </small>
          </div>
        ))}
      </Panel>
      <Panel title="Spark SQL">
        <div className="stage-meta">
          <span className="badge mock">
            {task.snapshot.spark_sql.generation_source.toUpperCase()}
          </span>
          <span>Validation: {task.snapshot.validation.status}</span>
        </div>
        <pre className="sql-code">
          <code>{task.snapshot.spark_sql.content}</code>
        </pre>
        <div className="validation-strip">
          <span>
            ✓ {task.snapshot.validation.referenced_tables.length} referenced
            tables
          </span>
          <span>
            ✓ {task.snapshot.validation.output_columns.length} output columns
          </span>
          <span>✓ {task.snapshot.validation.joins.length} known joins</span>
        </div>
      </Panel>
      <Panel title="Sink Snapshot">
        <div className="sink-detail">
          <div>
            <small>Dataset</small>
            <b>
              {task.snapshot.sink.catalog}.{task.snapshot.sink.database}.
              {task.snapshot.sink.table}
            </b>
          </div>
          <Metric label="Write mode" value={task.snapshot.sink.write_mode} />
          <Metric
            label="Partitions"
            value={task.snapshot.sink.partition_columns.join(", ") || "None"}
          />
        </div>
      </Panel>
      <Panel title="Runner">
        <div className="runner-state">
          <span>⚡</span>
          <div>
            <b>SparkJobRunner</b>
            <p>
              {task.stage === "runner_not_configured"
                ? "Approved. Waiting for SparkJobRunner integration."
                : "Runner is not configured for this POC."}
            </p>
          </div>
        </div>
      </Panel>
      <div className="detail-actions">
        {task.status === "waiting_submit" && (
          <button className="primary-button" onClick={() => action("submit")}>
            Submit Request
          </button>
        )}
        {task.status === "waiting_approval" &&
          task.stage === "approval_pending" && (
            <>
              <button
                className="demo-button"
                onClick={() => action("demo-approve")}
              >
                Demo · Approve
              </button>
              <button
                className="danger-button"
                onClick={() => action("demo-fail")}
              >
                Demo · Reject
              </button>
            </>
          )}
        {task.status === "waiting_approval" &&
          task.stage === "runner_not_configured" && (
            <>
              <button
                className="demo-button"
                onClick={() => action("demo-succeed")}
              >
                Demo · Mark Success
              </button>
              <button
                className="danger-button"
                onClick={() => action("demo-fail")}
              >
                Demo · Mark Failed
              </button>
            </>
          )}
        <button onClick={() => action("copy")}>Copy Request</button>
      </div>
    </div>
  );
}

export function Admin({ space, section }: { space: Space; section: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null),
    [semantic, setSemantic] = useState<Semantic | null>(null),
    [reviews, setReviews] = useState<any[]>([]),
    [bench, setBench] = useState<any>(null);
  useEffect(() => {
    api<Catalog>(`/spaces/${space.id}/metadata`).then(setCatalog);
    api<Semantic>(`/spaces/${space.id}/semantics`).then(setSemantic);
    api<any[]>("/reviews").then(setReviews);
    api<any>("/benchmarks").then(setBench);
  }, [space.id]);
  const dataDomains = [
    {name: "Sales Operations", description: "Orders, transactions, and commercial activity", tables: ["orders", "order_items"]},
    {name: "Customer", description: "Customer identity and regional attributes", tables: ["customers"]},
    {name: "Product", description: "Product catalog and merchandising dimensions", tables: ["products"]},
  ];
  const tierLabel = (tier: Table["data_tier"]) =>
    ({T1: "T1 · Raw", T2: "T2 · Curated", T3: "T3 · Aggregated"})[tier];
  if (section === "settings")
    return (
      <div className="admin-page">
        <Title
          title="Space Settings"
          sub="Configure metadata, query targets, and model capabilities."
        />
        <div className="grid two">
          <Panel title="Metadata Provider">
            <Option active title="Local file" desc="YAML / JSON · Connected" />
            <Option title="Collibra" desc="Provider reserved · Not connected" />
          </Panel>
          <Panel title="Query Target">
            <Option
              active
              title="MySQL"
              desc="Implemented · Mock target active"
            />
            <Option title="Spark SQL" desc="Runner interface reserved" />
            <Option title="Hive" desc="Not connected" />
          </Panel>
        </div>
        <Panel title="Model Settings">
          <div className="form-row">
            <label>
              API protocol
              <input value="OpenAI Compatible" readOnly />
            </label>
            <label>
              Model
              <input value="OPENAI_MODEL environment variable" readOnly />
            </label>
          </div>
          <p className="hint">
            Secrets are read by the backend and never returned to the browser.
          </p>
        </Panel>
      </div>
    );
  if (section === "semantics")
    return (
      <div className="admin-page">
        <Title
          title="Data & Semantics"
          sub="Manage the metadata and business context used by generation."
        />
        <div className="grid semantics">
          <Panel title={`Data Assets · ${catalog?.tables.length ?? 0} tables · ${dataDomains.length} domains`}>
            <div className="metadata-tree">
              {dataDomains.map((domain) => {
                const tables = catalog?.tables.filter((table) => domain.tables.includes(table.name)) || [];
                return <section className="data-domain" aria-label={`${domain.name} domain`} key={domain.name}>
                  <header className="data-domain-head">
                    <div><span>DOMAIN</span><b>{domain.name}</b><small>{domain.description}</small></div>
                    <em>{tables.length} {tables.length === 1 ? "dataset" : "datasets"}</em>
                  </header>
                  {tables.map((t) => (
                    <details key={t.name} open>
                      <summary>
                        <span className="table-icon">▦</span>
                        <div className="dataset-identity"><b>{t.name}</b><em>{t.description}</em></div>
                        <div className="dataset-governance">
                          <span className={`tier-badge ${t.data_tier.toLowerCase()}`}>{tierLabel(t.data_tier)}</span>
                          <span><small>Owner</small>{t.owner}</span>
                          <span><small>Classification</small>{t.name === "customers" ? "Restricted" : "Internal"}</span>
                          <span><small>Your access</small>{t.name === "customers" ? "Query" : "Manage"}</span>
                        </div>
                      </summary>
                      {t.columns.map((c) => (
                        <div className="column" key={c.name}>
                          <code>{c.name}</code>
                          <span>{c.data_type}</span>
                          <small>{c.description}</small>
                        </div>
                      ))}
                    </details>
                  ))}
                </section>;
              })}
            </div>
          </Panel>
          <div>
            <Panel title="User Access">
              <div className="access-profile">
                <span>AM</span>
                <div><b>Alex Morgan</b><small>Data Administrator · Active</small></div>
                <em>FULL ACCESS</em>
              </div>
              <div className="access-groups">
                <small>GROUP MEMBERSHIP</small>
                <span><b>Data Administrators</b><em>Manage · All domains</em></span>
                <span><b>Sales Analytics</b><em>Query · Sales Operations</em></span>
              </div>
              <button className="manage-access-button">Manage Access</button>
            </Panel>
            <Panel title="Business Metrics">
              {semantic?.metrics.map((m) => (
                <div className="semantic-item" key={m.name}>
                  <b>{m.name}</b>
                  <code>{m.expression}</code>
                  <p>{m.description}</p>
                </div>
              ))}
            </Panel>
            <Panel title="Business Terms">
              {semantic?.terms.map((t) => (
                <div className="semantic-item" key={t.name}>
                  <b>{t.name}</b>
                  <p>{t.definition}</p>
                </div>
              ))}
            </Panel>
            <Panel title="Examples">
              {semantic?.examples.map((e) => (
                <div className="semantic-item" key={e.question}>
                  <b>✓ {e.question}</b>
                  <code>{e.sql}</code>
                </div>
              ))}
            </Panel>
          </div>
        </div>
      </div>
    );
  return (
    <div className="admin-page">
      <Title
        title="Question Monitoring"
        sub="Improve the data space from real questions and feedback."
      />
      <div className="stats">
        <Stat n={reviews.length} label="Feedback" />
        <Stat
          n={reviews.filter((r) => r.status === "pending").length}
          label="Pending review"
          warn
        />
        <Stat n={bench?.summary.passed ?? 0} label="Benchmarks passed" />
        <Stat n="67%" label="Current accuracy" />
      </div>
      <Panel title="Recent Interactions">
        <table>
          <thead>
            <tr>
              <th>Question / Answer</th>
              <th>Feedback</th>
              <th>Source</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {reviews.length ? (
              reviews.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.response.question || r.title}</b>
                    <small>{r.response.answer}</small>
                  </td>
                  <td>
                    {r.rating === "negative"
                      ? "👎 Needs improvement"
                      : "👍 Correct"}
                  </td>
                  <td>
                    <span className="badge mock">MOCK</span>
                  </td>
                  <td>
                    <span className="status">
                      {r.status === "pending" ? "Pending" : "Resolved"}
                    </span>
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="empty">
                  User feedback will appear here.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Panel>
      <Panel title="Benchmark Questions">
        {bench?.items.map((b: any) => (
          <div className="benchmark" key={b.question}>
            <span>{b.question}</span>
            <b className={b.status}>
              {b.status === "passed" ? "✓ Passed" : "◷ Needs review"}
            </b>
          </div>
        ))}
      </Panel>
    </div>
  );
}

export default function App() {
  const [spaces, setSpaces] = useState<Space[]>([]),
    [role, setRole] = useState<"business" | "admin">("business"),
    [section, setSection] = useState("chat"),
    [focusTask, setFocusTask] = useState<string>();
  useEffect(() => {
    api<Space[]>("/spaces").then(setSpaces);
  }, []);
  const space = spaces[0];
  const nav =
    role === "business"
      ? [
          ["agents", "✦", "Specialist Agents"],
          ["chat", "⌁", "Data Chat"],
          ["transform", "⇄", "Data Transformation"],
          ["tasks", "▤", "Task Center"],
        ]
      : [
          ["settings", "⚙", "Space Settings"],
          ["semantics", "◇", "Data & Semantics"],
          ["monitoring", "◉", "Question Monitoring"],
        ];
  function created(id: string) {
    setFocusTask(id);
    setSection("tasks");
  }
  return (
    <div className="app">
      <nav className="sidebar">
        <div className="logo">
          <span>✦</span>
          <div>
            <b>DataChat</b>
            <small>Conversational BI</small>
          </div>
        </div>
        <div className="role-switch">
          <button
            className={role === "business" ? "active" : ""}
            onClick={() => {
              setRole("business");
              setSection("chat");
            }}
          >
            Business
          </button>
          <button
            className={role === "admin" ? "active" : ""}
            onClick={() => {
              setRole("admin");
              setSection("settings");
            }}
          >
            Admin
          </button>
        </div>
        <p className="nav-label">Workspace</p>
        <div className="space-pill">
          <span>S</span>
          <div>
            <b>Sales Analytics</b>
            <small>DEMO</small>
          </div>
        </div>
        <div className="nav-items">
          {nav.map(([id, icon, label]) => (
            <button
              key={id}
              className={section === id ? "active" : ""}
              onClick={() => setSection(id)}
            >
              <i>{icon}</i>
              {label}
            </button>
          ))}
        </div>
        <div className="profile">
          <span>AM</span>
          <div>
            <b>Alex Morgan</b>
            <small>
              {role === "admin" ? "Data Administrator" : "Business Analyst"}
            </small>
          </div>
          <button>⋯</button>
        </div>
      </nav>
      {space ? (
        section === "agents" ? (
          <SpecialistAgents />
        ) : section === "chat" ? (
          <Chat space={space} />
        ) : section === "transform" ? (
          <TransformationBuilder space={space} onCreated={created} />
        ) : section === "tasks" ? (
          <TaskCenter focusId={focusTask} />
        ) : (
          <Admin space={space} section={section} />
        )
      ) : (
        <div className="loading-page">Loading data space…</div>
      )}
    </div>
  );
}

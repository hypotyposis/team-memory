import type { KnowledgeItem, ReuseReport } from "./types";

export const mockKnowledge: KnowledgeItem[] = [
  {
    id: "k-001",
    claim: "infer-monorepo 的主架构轴是 DEPLOY_MODE，不是目录结构",
    detail: `同一套 \`infer/\` 代码通过 \`DEPLOY_MODE\` 跑两种人格：
- \`inference\`：无状态推理网关，嵌入 LiteLLM，PG 只读，产出用量事件到 Redis Stream
- \`control\`：控制面，不嵌入 LiteLLM，PG 读写，消费所有区域的用量事件，运行计费 Worker
- \`standalone\`：开发糖衣，fork 出 control + inference 两个进程`,
    source: ["https://github.com/RiemaLabs/infer-monorepo"],
    project: "infer-monorepo",
    module: "architecture",
    tags: ["architecture", "deploy-mode", "infrastructure"],
    confidence: "high",
    staleness_hint: "Stable unless DEPLOY_MODE enum changes",
    owner: "Spike",
    created_at: "2026-04-13T23:55:00Z",
  },
  {
    id: "k-002",
    claim: "所有 PG 写只能从 control plane 发出",
    detail: "`DeployMode.allows_pg_writes` 在代码层面强制执行。inference 节点必须保持 PG 只读。这是最硬的架构不变量。",
    source: ["https://github.com/RiemaLabs/infer-monorepo", "infer/core/deploy_mode.py"],
    project: "infer-monorepo",
    module: "database",
    tags: ["architecture", "database", "constraint"],
    confidence: "high",
    staleness_hint: "Stable unless DeployMode refactored",
    owner: "Spike",
    related_to: ["k-001"],
    created_at: "2026-04-13T23:55:30Z",
  },
  {
    id: "k-003",
    claim: "计费是异步 usage 管线，不是同步 PG 写",
    detail: `\`\`\`
inference → UsageMirrorCallback → ResilientProducer(WAL) → Redis Stream
  → BillingConsumer(控制面) → billing_usage_records + ledger_entries
\`\`\`
异步 usage + 集中式写入 + 账本审计优先。`,
    source: ["https://github.com/RiemaLabs/infer-monorepo", "infer/billing/runtime.py", "infer/streams/resilient_producer.py"],
    project: "infer-monorepo",
    module: "billing",
    tags: ["billing", "architecture", "async"],
    confidence: "high",
    staleness_hint: "Recheck after billing pipeline refactor",
    owner: "Jet",
    related_to: ["k-001", "k-002"],
    created_at: "2026-04-13T23:56:00Z",
  },
  {
    id: "k-004",
    claim: "三层认证架构：WorkOS → Auth Station → RS256 Internal JWT → Infer session",
    detail: `- Auth Station 是 SSO/identity gateway，回答"你是谁"
- Infer + LiteLLM 本地状态决定"你能干什么"
- WorkOS access_token 永远不离开 Auth Station`,
    source: ["https://github.com/RiemaLabs/infer-monorepo", "infer/auth/session.py", "auth/"],
    project: "infer-monorepo",
    module: "auth",
    tags: ["auth", "security", "architecture"],
    confidence: "high",
    staleness_hint: "Stable unless auth provider changes",
    owner: "Spike",
    created_at: "2026-04-13T23:56:30Z",
  },
  {
    id: "k-005",
    claim: "infer/streams/consumer.py 有 14 处 bare except Exception 吞错误",
    detail: "约占全项目 40%，多处 silently swallow 无日志。这是最严重的代码质量问题之一。",
    source: ["https://github.com/RiemaLabs/infer-monorepo", "infer/streams/consumer.py:117-872"],
    project: "infer-monorepo",
    module: "streams",
    tags: ["tech-debt", "error-handling", "code-quality"],
    confidence: "high",
    staleness_hint: "Recheck after error handling cleanup",
    owner: "Faye",
    created_at: "2026-04-14T00:02:00Z",
  },
  {
    id: "k-006",
    claim: "infer/x402/routes.py（921 行）是后端最大文件，混合 HTTP 路由 + 业务逻辑 + LiteLLM 代理调用",
    detail: "9/11 个文件无单测。x402_chat_completions_stream 函数 215 行。需要拆分关注点。",
    source: ["https://github.com/RiemaLabs/infer-monorepo", "infer/x402/routes.py"],
    project: "infer-monorepo",
    module: "x402",
    tags: ["tech-debt", "testing", "code-quality"],
    confidence: "high",
    staleness_hint: "Recheck after x402 module refactor",
    owner: "Faye",
    created_at: "2026-04-14T00:02:30Z",
  },
  {
    id: "k-007",
    claim: "@slock-ai/daemon 没有做混淆，代码完全可读",
    detail: "标准 tsup bundle 输出。零 eval、零 hex escape、零 base64。变量名保持原始语义，源文件路径注释保留。",
    source: ["https://www.npmjs.com/package/@slock-ai/daemon"],
    project: "slock-daemon",
    tags: ["reverse-engineering", "analysis"],
    confidence: "high",
    staleness_hint: "Recheck on new package version",
    owner: "Faye",
    created_at: "2026-04-14T00:07:00Z",
  },
  {
    id: "k-008",
    claim: "Slock daemon 是本地进程编排器，强依赖中心化后端",
    detail: `通过 WebSocket 连接 Slock 服务端，所有 chat 工具都是服务端 HTTP API 的代理。
支持 3 个 runtime driver：Claude Code、Codex CLI、Kimi CLI。
Agent 工作目录在 ~/.slock/agents/{agentId}/。`,
    source: ["https://www.npmjs.com/package/@slock-ai/daemon"],
    project: "slock-daemon",
    module: "architecture",
    tags: ["architecture", "reverse-engineering"],
    confidence: "high",
    staleness_hint: "Recheck on major daemon version bump",
    owner: "Faye",
    related_to: ["k-007"],
    created_at: "2026-04-14T00:10:00Z",
  },
];

export const mockReuseReport: ReuseReport = {
  total_queries: 12,
  hit_rate: 0.75,
  total_views: 9,
  total_items: 42,
  never_accessed_pct: 0.31,
  feedback_coverage: 0.67,
  north_star_count: 6,
  north_star_pct: 0.14,
  top_reused: [
    {
      knowledge_id: "6579131c-17c0-47fa-8b2e-a29380d0b5de",
      claim: "Shared Team Memory deployments should set TEAM_MEMORY_DB to an absolute path",
      view_count: 3,
      unique_owners: 2,
      useful_feedback_count: 2,
      not_useful_feedback_count: 0,
      outdated_feedback_count: 0,
    },
    {
      knowledge_id: "k-001",
      claim: "infer-monorepo 的主架构轴是 DEPLOY_MODE，不是目录结构",
      view_count: 2,
      unique_owners: 2,
      useful_feedback_count: 1,
      not_useful_feedback_count: 0,
      outdated_feedback_count: 0,
    },
  ],
  top_0hit_keywords: [
    {
      normalized_key: "billing refund",
      example_text: "Billing refund",
      query_count: 5,
    },
    {
      normalized_key: "stripe webhook retry",
      example_text: "stripe webhook retry",
      query_count: 3,
    },
  ],
  never_accessed: [
    {
      id: "60ad7408-ee84-4eb0-98f3-1dc1e5290546",
      claim: "In multi-Node environments, Team Memory backend and MCP should pin the same Node major version",
    },
    {
      id: "k-007",
      claim: "@slock-ai/daemon 没有做混淆，代码完全可读",
    },
  ],
};

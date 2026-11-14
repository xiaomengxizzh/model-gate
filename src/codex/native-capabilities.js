// 原生 Codex 能力清单（A1 记账，MG-R005/R006/R008/R011）。
//
// 目的：让任何后续读者无法把 "V1 原生路径可用" 误读成 "原生 Agent Team 已完成"。
// 每个能力都必须落在 PASS_MOCK / NOT_ACCEPTED / BLOCKED / NOT_TESTED 之一，
// PASS_REAL 在当前分支不存在（真实 Luna 调用未获授权），因此本清单里不允许出现该值。
//
// 机器可读：`nativeCapabilityInventory()` 返回纯 JSON 值（可 JSON.stringify 直接落盘）。
// 人工可读：`headline` 一句话说明整体结论；`gaps` 列出未闭环项。

export const CAPABILITY_STATUSES = Object.freeze(['PASS_MOCK', 'NOT_ACCEPTED', 'BLOCKED', 'NOT_TESTED'])

export const NATIVE_CAPABILITY_HEADLINE =
  'V1 原生路径（spawn / 工具轮 / 同子追派 / 正常退出后 resume）离线可复核；' +
  '原生 Agent Team 未完成：V2 单进程追派与 interrupt 为 NOT_ACCEPTED，真实 GPT-6 Luna 验收为 BLOCKED。'

const WAIT_SUITE = 'scripts/test/offline/agg-native-wait.test.mjs'
const INTERRUPT_SUITE = 'scripts/test/offline/agg-native-interrupt.test.mjs'
const INVARIANTS_SUITE = 'scripts/test/offline/agg-native-invariants.test.mjs'
const CAPABILITY_SUITE = 'scripts/test/offline/agg-native-capabilities.test.mjs'
const V1_E2E = 'scripts/test/codex-e2e.mjs --native-v1'
const LIVE_EVIDENCE = 'docs/evidence/2026-11-13-modelgate-native-live.md'

export const NATIVE_CAPABILITIES = Object.freeze([
  {
    id: 'v1_spawn',
    version: 'v1',
    feature: '父代理通过原生 multi_agent_v1.spawn_agent 创建子代理（含 Go 子模型）',
    status: 'PASS_MOCK',
    gatewayRole: 'adapts protocol only; Codex harness spawns the child',
    evidence: { type: 'e2e-script', command: V1_E2E, observation: '11/11 documented on the synthetic V1 parent; child requests hit the loopback Go mock' },
    suite: null,
    notes: '合成父代理 + 回环 mock；不是 Desktop 真实验收。',
  },
  {
    id: 'v1_tool_rounds',
    version: 'v1',
    feature: '子代理执行真实工具并把工具回执回填父代理 wait',
    status: 'PASS_MOCK',
    gatewayRole: 'relays tool items unchanged (call_id pairing checked, never rewritten)',
    evidence: { type: 'e2e-script', command: V1_E2E, observation: 'two tool rounds with exit code 0 and marker present on the same child id' },
    suite: null,
    notes: '工具执行由 Codex harness 完成，不是网关派单。',
  },
  {
    id: 'v1_followup_same_child',
    version: 'v1',
    feature: '同一子代理追派第二个任务（不新建子代理）',
    status: 'PASS_MOCK',
    gatewayRole: 'relays send_input; preserves target/call_id',
    evidence: { type: 'e2e-script', command: V1_E2E, observation: 'same child id performs turn A then turn B; B request keeps A context and tool output' },
    suite: null,
    notes: null,
  },
  {
    id: 'v1_resume',
    version: 'v1',
    feature: '父进程正常退出后 resume 同一父线程，历史与子身份不变，不重复派单',
    status: 'PASS_MOCK',
    gatewayRole: 'projects resume history; control items dropped with explicit lossy code',
    evidence: { type: 'e2e-script', command: V1_E2E, observation: 'resume observes A/B history, no new child dispatch, same child id' },
    suite: null,
    notes: null,
  },
  {
    id: 'v2_wait_collect',
    version: 'v2',
    feature: 'Code Mode 单元让出 + 顶层 wait(cell_id) 收取，同一 cell 恰好一个终态',
    status: 'PASS_MOCK',
    gatewayRole: 'adapts: cell ledger rejects unbound waits and duplicate dispatch before any upstream request',
    evidence: { type: 'offline-suite', suite: WAIT_SUITE, observation: 'yield -> wait -> settle resolves one terminal; second wait rejected with code_mode_cell_duplicate_dispatch' },
    suite: WAIT_SUITE,
    notes: '网关侧状态机闭环已离线证明；单进程真实父代理是否自动收取仍属未验证（真实运行需授权）。',
  },
  {
    id: 'v2_followup_single_process',
    version: 'v2',
    feature: 'V2 单进程内完成初派 + 追派（不靠会话 resume）',
    status: 'NOT_ACCEPTED',
    gatewayRole: 'relays followup_task; cannot drive the parent cell loop',
    evidence: { type: 'real-run-observation', path: LIVE_EVIDENCE, observation: '首次父进程在 Code Mode 等待阶段停滞约 230s；追派只在 resume 之后才发生' },
    suite: null,
    missing: {
      messageTypes: [],
      fields: ['cell_id', 'status'],
      why: '上游 Responses 只有 function_call / function_call_output；父代理不调用顶层 wait({cell_id}) 时网关没有任何可发送的消息能让父代理继续。',
    },
    notes: '保留目标；不得用外部调度器或经典 V1 冒充。',
  },
  {
    id: 'v2_interrupt',
    version: 'v2',
    feature: '任务进行中中断子代理，子代理进入唯一终态 interrupted，且无额外工具派单',
    status: 'NOT_ACCEPTED',
    gatewayRole: 'can relay collaboration.interrupt_agent call/output identity; cannot express a cancel to the upstream',
    evidence: { type: 'protocol-absence', path: 'src/responses.js', observation: 'native SSE 终态只有 completed / failed / incomplete；无 cancel/interrupt 消息类型' },
    suite: INTERRUPT_SUITE,
    missing: {
      messageTypes: ['response.cancel', 'response.interrupted'],
      fields: ['status:"interrupted"', 'cell_id'],
      why: 'collaboration.interrupt_agent 是 Codex harness 的本地工具调用，网关只看到一次 function_call + 输出；上游协议没有 cancel 帧，也没有 interrupted 终态，网关无法证明“单一中断终态”。',
    },
    notes: '网关侧仍保证：客户端中断时下游 SSE 记录唯一终态（CLIENT_CANCELED），且 interrupt_agent 的身份/关联 ID 原样还原。',
  },
  {
    id: 'cross_provider_child',
    version: 'v1',
    feature: 'GPT 父模型 + 非 GPT 子模型（OpenCode Go）原生父子协作',
    status: 'PASS_MOCK',
    gatewayRole: 'routes parent and child to different upstreams with separate credentials',
    evidence: { type: 'e2e-script', command: V1_E2E, observation: 'parent hits the official-shaped mock, child hits the Go Responses mock with the vendor model name' },
    suite: null,
    notes: '真实 GPT-6 Luna 父模型未运行。',
  },
  {
    id: 'sse_single_terminal',
    version: 'any',
    feature: '每个 Responses 流恰好一个终态，终态前保留预算/并发槽位，终端中断也记录终态',
    status: 'PASS_MOCK',
    gatewayRole: 'adapts: adapter owns terminal state and cell reservations',
    evidence: { type: 'offline-suite', suite: INTERRUPT_SUITE, observation: 'client cancel mid-stream yields exactly one response.failed/CLIENT_CANCELED and no later tool item' },
    suite: INTERRUPT_SUITE,
    notes: null,
  },
  {
    id: 'unreadable_ciphertext_not_forwarded',
    version: 'any',
    feature: '不可读密文任务不得作为空任务转发给第三方原生上游',
    status: 'PASS_MOCK',
    gatewayRole: 'adapts: rejects opaque_collaboration_task before any upstream request',
    evidence: { type: 'offline-suite', suite: INVARIANTS_SUITE, observation: 'ciphertext only in collaboration tool arguments -> typed rejection, zero upstream hits' },
    suite: INVARIANTS_SUITE,
    notes: null,
  },
  {
    id: 'real_luna_parent',
    version: 'any',
    feature: '真实 GPT-6 Luna 父模型经网关完成原生父子协作（MG-R012）',
    status: 'BLOCKED',
    gatewayRole: 'relays official target only',
    evidence: { type: 'policy', path: 'docs/product/2026-11-14-owner-product-contract.md' },
    suite: null,
    blocker: '未获得付费/真实 Luna 调用授权；本轮禁止真实 OAuth 与真实模型调用。',
    notes: '无资格即 BLOCKED，不代换其它 GPT 模型。',
  },
  {
    id: 'codex_desktop_gui_native',
    version: 'any',
    feature: '在原版 Codex Desktop GUI 内使用原生父子协作（MG-R004/R005 的真实入口）',
    status: 'BLOCKED',
    gatewayRole: 'none (gateway cannot observe GUI acceptance)',
    evidence: { type: 'policy', path: 'docs/product/2026-11-14-owner-product-contract.md' },
    suite: null,
    blocker: '需所有者授权在真实 Desktop 内逐模型操作；CLI 与 mock 不冒充 GUI 验收。',
    notes: null,
  },
])

/** 纯 JSON 清单：能力 + 汇总 + 缺口，供诊断/证据落盘。 */
export function nativeCapabilityInventory() {
  const counts = {}
  for (const status of CAPABILITY_STATUSES) counts[status] = 0
  const gaps = []
  for (const cap of NATIVE_CAPABILITIES) {
    counts[cap.status] = (counts[cap.status] || 0) + 1
    if (cap.status === 'NOT_ACCEPTED') gaps.push({ id: cap.id, code: 'NOT_ACCEPTED', missing: cap.missing })
    if (cap.status === 'BLOCKED') gaps.push({ id: cap.id, code: 'BLOCKED', blocker: cap.blocker })
  }
  return {
    schema: 'mg.codex.native-capabilities/v1',
    headline: NATIVE_CAPABILITY_HEADLINE,
    agentTeamComplete: gaps.length === 0,
    counts,
    capabilities: NATIVE_CAPABILITIES.map((cap) => JSON.parse(JSON.stringify(cap))),
    gaps,
    suites: [WAIT_SUITE, INTERRUPT_SUITE, INVARIANTS_SUITE, CAPABILITY_SUITE],
  }
}

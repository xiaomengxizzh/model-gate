import { check, snapshot } from './utils.mjs'

// 请求体大小上限：需网关以较小 maxBodyBytes 启动（如 MG_MAX_BODY=1000）才有意义；否则 SKIP
const st = await snapshot()
const limit = st.server.maxBodyBytes
const LARGE = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'A'.repeat(2000) }] })
if (!limit || limit <= 0) {
  check('请求体大小上限', true, null, true) // SKIP：未启用限制
} else {
  const r = await fetch(`http://127.0.0.1:8787/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: LARGE })
  const tx = await r.text()
  check('请求体超限→413', r.status === 413 && tx.includes('payload_too_large'), { status: r.status, limit })
}
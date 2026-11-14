// Sign in with ChatGPT for the local ModelGate integration.
import http from 'node:http'
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto'
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'

const issuer = 'https://auth.openai.com'
const resource = 'https://api.openai.com/v1'
const dynamicClient = 'dynamic_agent_client'
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
const planScopes = ['resource.invoke', 'chatgpt.tokens.use.direct']
const clientIdPattern = /^oaiapp_[a-zA-Z0-9_-]+$/
const random = () => randomBytes(32).toString('base64url')

async function atomicPrivateJson(path, value) {
  const temporary = path + '.' + randomUUID()
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

async function requestJson(url, options) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) })
  if (response.ok) return response.json()
  let code
  try {
    const body = await response.json()
    code = typeof body.error === 'string' ? body.error : body.error?.code
  } catch {}
  const safeCode = typeof code === 'string' && /^[a-z0-9_]{1,80}$/.test(code) ? ' ' + code : ''
  throw new Error('OpenAI HTTP ' + response.status + safeCode)
}

async function validateIdentity(idToken, clientId, nonce) {
  if (typeof idToken !== 'string') throw new Error('Missing identity token')
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new Error('Invalid identity token')
  const [protectedHeader, payload, signature] = parts
  const header = JSON.parse(Buffer.from(protectedHeader, 'base64url'))
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid identity token algorithm')
  const { keys } = await requestJson(issuer + '/.well-known/jwks.json')
  const key = keys.find((entry) => entry.kid === header.kid && entry.kty === 'RSA')
  if (!key || !verify('RSA-SHA256', Buffer.from(protectedHeader + '.' + payload), createPublicKey({ format: 'jwk', key }), Buffer.from(signature, 'base64url'))) {
    throw new Error('Invalid identity token signature')
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url'))
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== issuer || !audiences.includes(clientId) ||
      (audiences.length > 1 && claims.azp !== clientId) || claims.nonce !== nonce ||
      !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000 ||
      typeof claims.sub !== 'string' || !claims.sub) throw new Error('Invalid identity token claims')
  return claims.sub
}

async function exchange(parameters) {
  return requestJson(issuer + '/api/accounts/oauth/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...parameters, resource }),
  })
}

function grantOf(response, previous) {
  const granted = typeof response.scope === 'string' ? response.scope.split(/\s+/) : previous?.scopes || []
  const seconds = Number(response.expires_in)
  if (!planScopes.every((scope) => granted.includes(scope)) ||
      typeof response.access_token !== 'string' || !response.access_token ||
      String(response.token_type).toLowerCase() !== 'bearer' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('ChatGPT plan permission or valid access token missing')
  }
  const refreshToken = response.refresh_token || previous?.refreshToken
  if (typeof refreshToken !== 'string' || !refreshToken) throw new Error('Missing refresh token')
  return { accessToken: response.access_token, refreshToken, scopes: granted, expiresAt: Date.now() + seconds * 1000 }
}

export async function signIn(directory, presentUrl) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const hostPath = join(directory, 'host.json')
  let hostId
  try {
    hostId = JSON.parse(await readFile(hostPath, 'utf8')).hostId
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    hostId = 'urn:uuid:' + randomUUID()
    await writeFile(hostPath, JSON.stringify({ hostId }), { mode: 0o600, flag: 'wx' })
  }
  if (!/^urn:uuid:[0-9a-f-]{36}$/.test(hostId || '')) throw new Error('Invalid local host identity')
  const grantPath = join(directory, 'grant.json')
  try {
    await readFile(grantPath)
    throw new Error('A ChatGPT connection already exists in this directory')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const state = random()
  const nonce = random()
  const verifier = random()
  const challenge = createHash('sha256').update(verifier).digest('base64url')

  let redirectUri
  let claimed = false
  const server = http.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  redirectUri = 'http://127.0.0.1:' + server.address().port + '/auth/callback'
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ChatGPT authorization timed out')), 600000)
      const done = (error) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      server.on('request', async (req, res) => {
        let url
        try { url = new URL(req.url || '/', redirectUri) } catch { res.writeHead(400); res.end(); return }
        const send = (status, text) => {
          res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
          res.end(text)
        }
        if (req.method !== 'GET' || url.pathname !== '/auth/callback' ||
            req.headers.host !== '127.0.0.1:' + server.address().port) return send(404, 'Not found')
        if (url.searchParams.get('state') !== state || claimed) return send(400, 'Invalid authorization state')
        claimed = true
        try {
          if (url.searchParams.has('error')) throw new Error('ChatGPT authorization declined')
          const code = url.searchParams.get('code')
          const clientId = url.searchParams.get('client_id')
          if (!code || !clientIdPattern.test(clientId || '')) throw new Error('Incomplete ChatGPT registration')
          const response = await exchange({ grant_type: 'authorization_code', code, client_id: clientId,
            code_verifier: verifier, redirect_uri: redirectUri })
          const subject = await validateIdentity(response.id_token, clientId, nonce)
          await atomicPrivateJson(grantPath, { clientId, subject, ...grantOf(response) })
          send(200, 'ModelGate 已连接 ChatGPT 套餐。可以关闭此标签页。')
          done()
        } catch (error) {
          send(400, 'ModelGate 未能连接 ChatGPT 套餐。请回到 ModelGate 查看状态。')
          done(error)
        }
      })
      const authorizeUrl = new URL(issuer + '/api/accounts/authorize')
      authorizeUrl.search = new URLSearchParams({
        client_id: dynamicClient, agent_name_hint: 'ModelGate', ext_agent_host_id: hostId,
        response_type: 'code', redirect_uri: redirectUri, scope: scopes, resource,
        state, nonce, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString()
      Promise.resolve().then(() => presentUrl(authorizeUrl.href)).catch(done)
    })
  } finally {
    server.close()
  }
}

export function createPlanCredential(directory) {
  const grantPath = join(directory, 'grant.json')
  let inFlight
  async function load() {
    const grant = JSON.parse(await readFile(grantPath, 'utf8'))
    if (!clientIdPattern.test(grant.clientId || '') || !grant.subject ||
        !planScopes.every((scope) => grant.scopes?.includes(scope))) throw new Error('Invalid ChatGPT grant')
    if (grant.expiresAt > Date.now() + 60000 && grant.accessToken) return grant.accessToken
    const response = await exchange({ grant_type: 'refresh_token', client_id: grant.clientId, refresh_token: grant.refreshToken })
    const refreshed = grantOf(response, grant)
    await atomicPrivateJson(grantPath, { clientId: grant.clientId, subject: grant.subject, ...refreshed })
    return refreshed.accessToken
  }
  return () => {
    inFlight ??= load().finally(() => { inFlight = null })
    return inFlight
  }
}

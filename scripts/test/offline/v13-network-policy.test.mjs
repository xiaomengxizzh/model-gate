import test from 'node:test'
import assert from 'node:assert/strict'
import { validateEndpointNetwork } from '../../../src/resources/network-policy.js'

const PUBLIC_V4 = '192.0.2.10'
const PUBLIC_V6 = '2001:db8::10'

function lookupFor(addresses) {
  return async (hostname, options) => {
    assert.equal(hostname, 'api.example.test')
    assert.deepEqual(options, { all: true, verbatim: true })
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
}

const blockedAddresses = [
  '0.0.0.0', '0.1.2.3', '10.1.2.3',
  '100.64.0.1', '100.127.255.254', '127.0.0.1',
  '169.254.1.2', '169.254.169.254',
  '172.16.0.1', '172.31.255.254', '192.168.1.1',
  '198.18.0.1', '198.19.255.254', '224.0.0.1', '240.0.0.1', '255.255.255.255',
  '::', '::1', '::127.0.0.1', '::ffff:0.0.0.0', '::ffff:127.0.0.1',
  '::ffff:10.1.2.3', '::ffff:100.64.0.1', '::ffff:169.254.169.254',
  '::ffff:192.168.1.1', '::ffff:224.0.0.1', '::ffff:0:127.0.0.1',
  '64:ff9b::127.0.0.1',
  'fc00::1', 'fd12:3456::1', 'fe80::1', 'febf::1', 'fec0::1', 'ff02::1',
]

test('网络策略：真实 localhost 使用 Promise DNS 并返回可固定地址', async () => {
  const result = await validateEndpointNetwork('http://localhost:8787', { allowPrivateNetwork: true })
  assert.equal(result.error, undefined)
  assert.equal(result.hostname, 'localhost')
  assert.ok(result.addresses.some((answer) => answer.address === '127.0.0.1' || answer.address === '::1'))
})

test('网络策略：允许公开双栈地址并按 all/verbatim 请求全部 DNS 答案', async () => {
  const result = await validateEndpointNetwork('https://api.example.test/v1/', {
    lookup: lookupFor([PUBLIC_V4, PUBLIC_V6]),
  })
  assert.equal(result.error, undefined)
  assert.equal(result.value, 'https://api.example.test/v1')
  assert.equal(result.hostname, 'api.example.test')
  assert.deepEqual(result.addresses, [
    { address: PUBLIC_V4, family: 4 },
    { address: PUBLIC_V6, family: 6 },
  ])
})

test('网络策略：逐一拒绝私网、保留、元数据、组播及 IPv6 映射地址', async () => {
  for (const address of blockedAddresses) {
    const result = await validateEndpointNetwork('https://api.example.test', { lookup: lookupFor([address]) })
    assert.equal(result.code, 'private_address', address)
    assert.match(result.error, /禁止的网络地址/)
  }
})

test('网络策略：只有显式 allowPrivateNetwork 允许受限地址', async () => {
  for (const allowPrivateNetwork of [undefined, false, 'true', 1]) {
    const result = await validateEndpointNetwork('https://api.example.test', {
      allowPrivateNetwork,
      lookup: lookupFor(['10.1.2.3']),
    })
    assert.equal(result.code, 'private_address')
  }
  const allowed = await validateEndpointNetwork('https://api.example.test', {
    allowPrivateNetwork: true,
    lookup: lookupFor(['10.1.2.3', '::ffff:127.0.0.1']),
  })
  assert.equal(allowed.error, undefined)
  assert.equal(allowed.addresses.length, 2)
})

test('网络策略：混合公开与私网答案时整体拒绝，不只看第一条', async () => {
  for (const addresses of [[PUBLIC_V4, '127.0.0.1'], ['fd00::1', PUBLIC_V6]]) {
    const result = await validateEndpointNetwork('https://api.example.test', { lookup: lookupFor(addresses) })
    assert.equal(result.code, 'private_address')
  }
})

test('网络策略：IP 字面量无需 DNS，公开边界地址不被误杀', async () => {
  const lookup = () => assert.fail('IP 字面量不应触发 DNS')
  for (const address of [PUBLIC_V4, '198.51.100.20', PUBLIC_V6, '2001:db8:1::2', '::ffff:192.0.2.10']) {
    const host = address.includes(':') ? `[${address}]` : address
    const result = await validateEndpointNetwork(`http://${host}:8080/v1`, { lookup })
    const canonical = address === '::ffff:192.0.2.10' ? '::ffff:c000:20a' : address
    assert.equal(result.error, undefined, address)
    assert.deepEqual(result.addresses, [{ address: canonical, family: address.includes(':') ? 6 : 4 }])
  }
  assert.equal((await validateEndpointNetwork('http://127.0.0.1', { lookup })).code, 'private_address')
  assert.equal((await validateEndpointNetwork('http://[::ffff:192.168.1.1]', { lookup })).code, 'private_address')
  assert.equal((await validateEndpointNetwork('http://127.0.0.1', { lookup, allowPrivateNetwork: true })).error, undefined)
})

test('网络策略：边界拒绝凭据、fragment、协议、端口和无效主机名', async () => {
  const invalid = [
    '', 'not a url', 'http:api.example.test', 'ftp://api.example.test', 'file:///etc/passwd',
    'https://user:pass@api.example.test', 'https://@api.example.test',
    'https://api.example.test/#', 'https://api.example.test/path#fragment',
    'https://api.example.test:0', 'https://api.example.test:', 'https://api.example.test:65536',
    'https://api.example.test:abc', 'https://-bad.example.test', 'https://bad-.example.test',
    'https://bad_name.example.test', 'https://bad..example.test', 'https://.example.test',
    `https://${'a'.repeat(64)}.example.test`, 'https://[::1', 'https://[fe80::1%25eth0]',
    'https://api.example.test\\@other.example.test', 'https://api.example.test\n',
  ]
  for (const endpoint of invalid) {
    const result = await validateEndpointNetwork(endpoint, {
      lookup: () => assert.fail('无效边界不应触发 DNS: ' + endpoint),
      allowPrivateNetwork: true,
    })
    assert.equal(result.code, 'invalid_endpoint', endpoint)
  }
})

test('网络策略：DNS 异常、空答案、无效答案与超时均失败关闭', async () => {
  const failures = [
    async () => { throw new Error('synthetic DNS failure') },
    async () => [],
    async () => [{ address: 'not-an-ip', family: 4 }],
    async () => [{ address: PUBLIC_V4, family: 6 }],
    async () => [{ address: PUBLIC_V4 }],
    async () => [null],
    async () => PUBLIC_V4,
  ]
  for (const lookup of failures) {
    const result = await validateEndpointNetwork('https://api.example.test', { lookup })
    assert.equal(result.code, 'dns_error')
  }
  const timeout = await validateEndpointNetwork('https://api.example.test', {
    lookup: () => new Promise(() => {}),
    timeoutMs: 5,
  })
  assert.equal(timeout.code, 'dns_error')
  assert.match(timeout.error, /超时/)
})

test('网络策略：无效注入选项失败关闭且不调用查找', async () => {
  const lookup = () => assert.fail('无效选项不应触发 DNS')
  assert.equal((await validateEndpointNetwork('https://api.example.test', { lookup: null })).code, 'invalid_options')
  assert.equal((await validateEndpointNetwork('https://api.example.test', { lookup, timeoutMs: 0 })).code, 'invalid_options')
  assert.equal((await validateEndpointNetwork('https://api.example.test', { lookup, timeoutMs: Infinity })).code, 'invalid_options')
  assert.equal((await validateEndpointNetwork('https://api.example.test', null)).code, 'invalid_options')
})

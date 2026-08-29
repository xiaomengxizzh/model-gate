// 日志按天分文件 + 7 天保留 + 5MB 轮转（logger 单元级验证，自包含不依赖网关）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLogger } from '../../src/logger.js'
import { check } from './utils.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TMP = path.join(__dirname, '.tmp-log')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })
const spec = path.join(TMP, 'gw.log')
// 造旧文件：8 天前 dated、旧 .old、超 7 天未动的无日期旧版 gw.log、一个不该被碰的无关文件
const old = new Date(Date.now() - 8 * 86400000)
fs.writeFileSync(path.join(TMP, 'gw-2026-08-01.log'), 'x')
fs.writeFileSync(path.join(TMP, 'gw-2026-08-01.log.old'), 'x')
fs.writeFileSync(path.join(TMP, 'gw.log'), 'x')
fs.writeFileSync(path.join(TMP, 'keep-me.txt'), 'x')
for (const f of ['gw-2026-08-01.log', 'gw-2026-08-01.log.old', 'gw.log']) fs.utimesSync(path.join(TMP, f), old, old)

const log = createLogger({ logFile: spec, silent: true })
log.info('hello')
const n = new Date()
const ds = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0')

check('log·按天文件已创建', fs.existsSync(path.join(TMP, 'gw-' + ds + '.log')))
check('log·8 天前 dated 文件被清理', !fs.existsSync(path.join(TMP, 'gw-2026-08-01.log')))
check('log·旧 .old 轮转件被清理', !fs.existsSync(path.join(TMP, 'gw-2026-08-01.log.old')))
check('log·超 7 天无日期旧版按 mtime 清理', !fs.existsSync(path.join(TMP, 'gw.log')))
check('log·无关文件不误删', fs.existsSync(path.join(TMP, 'keep-me.txt')))
// 轮转：单文件累计写入 >5MB 触发 .old
for (let i = 0; i < 6; i++) log.info('x'.repeat(1024 * 1024))
check('log·超 5MB 轮转出 .old', fs.existsSync(path.join(TMP, 'gw-' + ds + '.log.old')))
check('log·file() 指向当前天文件', typeof log.file() === 'string' && log.file().includes('gw-' + ds))
fs.rmSync(TMP, { recursive: true, force: true })

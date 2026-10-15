import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { JSDOM } from 'jsdom'
import React, { act } from 'react'

const require = createRequire(import.meta.url)
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:3000' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')) }
let session = { data: { user: { id: 'test-user', name: 'Test user' } }, isPending: false, error: null }
let pushes = []
const Empty = () => null
const mocks = {
  '@/lib/auth-client': { useSession: () => session },
  'next/navigation': { useRouter: () => ({ push: value => pushes.push(value) }) },
  '@/components/locale-provider': { useLocale: () => ({ locale: 'ja', setLocale() {} }) },
  '@/components/use-display-identity': { useDisplayIdentity: () => ({ name: 'Test user' }) },
  '@/components/analytics-refresh-countdown': { AnalyticsRefreshCountdown: Empty },
  '@/components/runtime-provider-status': { RuntimeProviderStatus: Empty },
  '@/components/account-logout': { AccountLogout: Empty },
  '@/components/theme-customizer': { ThemeCustomizer: Empty },
  '@/components/message-history-import-panel': { MessageHistoryImportPanel: Empty },
  '@/components/community-analytics-dashboard': { CommunityAnalyticsDashboard: ({ view, guildId }) => React.createElement('div', { 'data-view': view, 'data-guild': guildId }, view) },
}
const cache = new Map()
function load(filename) {
  filename = path.resolve(base, filename)
  if (cache.has(filename)) return cache.get(filename)
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  const mod = { exports: {} }
  const localRequire = id => {
    if (mocks[id]) return mocks[id]
    if (id.startsWith('@/') || id.startsWith('.')) {
      const target = id.startsWith('@/') ? path.join(base, id.slice(2)) : path.resolve(path.dirname(filename), id)
      if (target.endsWith('.mjs')) return require(target)
      for (const extension of ['', '.tsx', '.ts']) if (existsSync(target + extension)) return load(target + extension)
    }
    return require(id)
  }
  new Function('require', 'module', 'exports', code)(localRequire, mod, mod.exports)
  cache.set(filename, mod.exports)
  return mod.exports
}
const navigation = load('lib/dashboard-navigation.ts')
const presentation = load('lib/dashboard-presentation.ts')
const Dashboard = load('app/dashboard/page.tsx').default
const Settings = load('app/settings/page.tsx').default
const pause = () => new Promise(resolve => setTimeout(resolve, 0))
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }
const guilds = [{ id: 'guild-a', name: 'とても長いサーバー名'.repeat(8), icon: null }, { id: 'guild-b', name: 'Guild B', icon: null }]
const snapshot = (count = 0, statsDays = 14) => ({ latestMemberCount: count, latestMessageCount: 0, totalMessageCount: 0, activeMemberCount: 0, chartPoints: [0, 0], memberPoints: [count, count], labels: ['10/14', '10/15'], coverage: { statsDays, messageDays: 0 }, readMeta: { available: statsDays > 0, freshness: statsDays ? 'fresh' : 'unavailable', provider: 'test', lastKnownGood: false }, botStatus: {} })
let statusRequest
function defaultFetch(url) {
  if (url === '/api/guilds') return Promise.resolve(response({ guilds }))
  if (url.startsWith('/backend/status')) return statusRequest ? statusRequest(url) : Promise.resolve(response(snapshot()))
  return Promise.resolve(response({ timeZone: 'Asia/Tokyo', language: 'ja', notifications: [], goals: [] }))
}
async function mount(Component) {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container)
  await act(async () => { root.render(React.createElement(Component)); await pause() })
  return { container, root, async dispose() { await act(async () => root.unmount()); container.remove() } }
}
async function click(element) { assert.ok(element, 'target exists'); await act(async () => { element.click(); await pause() }) }
async function selectGuild(ui, index = 0) {
  await click(ui.container.querySelector('button[aria-label="サーバーを選択"]'))
  await click([...ui.container.querySelectorAll('button')].find(e => e.querySelector('span[title]')?.textContent === guilds[index].name && !e.hasAttribute('aria-label')))
}

test('navigation and search resolve real views and routes; account is personal', () => {
  const items = navigation.dashboardNavigation
  assert.equal(new Set(items.map(i => i.id)).size, items.length)
  for (const id of ['overview','retention','health','diagnostics','channels','roles','insights']) assert.equal(items.find(i => i.id === id).view, id)
  assert.equal(navigation.searchNavigation('アナリティクス')[0].view, 'analytics')
  assert.equal(navigation.searchNavigation('Account')[0].group, 'personal')
  for (const item of items.filter(i => i.href)) assert.ok(existsSync(path.join(base, 'app', item.href, 'page.tsx')))
})

test('state precedence separates authentication, guild loading/errors and selection', () => {
  const baseInput = { pending: false, authError: false, signedIn: true, guildLoading: false, guildError: false, guildCount: 2, selected: true }
  for (const [patch, expected] of [[{pending:true},'auth_loading'],[{authError:true},'auth_error'],[{signedIn:false},'signed_out'],[{guildLoading:true},'guild_loading'],[{guildError:true},'guild_error'],[{guildCount:0},'no_guilds'],[{selected:false},'choose_guild'],[{},'ready']]) assert.equal(presentation.dashboardAccessState({...baseInput,...patch}),expected)
  const ready = { access:'ready',authorized:true,state:'connected',available:true,lastKnownGood:false,statsDays:1 }
  assert.equal(presentation.canDisplayDashboardData(ready),true)
  for (const patch of [{access:'signed_out'},{authorized:false},{state:'loading'},{statsDays:0},{available:false}]) assert.equal(presentation.canDisplayDashboardData({...ready,...patch}),false)
})

test('signed out and unselected dashboard never render initial zero metrics', async () => {
  globalThis.fetch = defaultFetch
  session = { data:null,isPending:false,error:null }
  let ui = await mount(Dashboard)
  assert.match(ui.container.textContent, /ログインして/)
  assert.doesNotMatch(ui.container.textContent, /ログイン中|順調に成長|重要指標|0 メンバー/)
  await ui.dispose()
  session = { data:{user:{id:'test-user'}},isPending:false,error:null }
  ui = await mount(Dashboard)
  assert.match(ui.container.textContent, /サーバーを選択すると/)
  assert.doesNotMatch(ui.container.textContent, /重要指標|0 メンバー/)
  await ui.dispose()
})

test('loading, empty, legitimate zero, failure and late Guild response', async () => {
  globalThis.fetch = defaultFetch
  const pending = deferred(); statusRequest = () => pending.promise
  const ui = await mount(Dashboard)
  await selectGuild(ui)
  assert.match(ui.container.textContent, /データを読み込んでいます/)
  assert.doesNotMatch(ui.container.textContent, /重要指標/)
  await act(async () => { pending.resolve(response(snapshot())); await pause() })
  assert.match(ui.container.textContent, /重要指標/)
  const metric = [...ui.container.querySelectorAll('button')].find(e=>e.textContent.startsWith('総メンバー数'))
  assert.match(metric.textContent, /0/)
  assert.doesNotMatch(metric.textContent, /あと1回/)
  const slow = deferred(); statusRequest = url => url.includes('guild-b') ? slow.promise : Promise.resolve(response(snapshot(25)))
  await selectGuild(ui,1)
  assert.doesNotMatch(ui.container.textContent, /重要指標/)
  await selectGuild(ui,0)
  await act(async () => { slow.resolve(response(snapshot(999))); await pause() })
  assert.doesNotMatch(ui.container.textContent, /999/)
  statusRequest = () => Promise.resolve(response({},403))
  await selectGuild(ui,1)
  assert.match(ui.container.textContent, /取得できませんでした/)
  assert.doesNotMatch(ui.container.textContent, /重要指標/)
  statusRequest = () => Promise.resolve(response(snapshot(0,0)))
  await selectGuild(ui,0)
  assert.match(ui.container.textContent, /記録データがまだありません/)
  assert.doesNotMatch(ui.container.textContent, /重要指標/)
  await ui.dispose(); statusRequest = undefined
})

test('mobile drawer uses all destinations, restores focus, and preserves Guild on view changes', async () => {
  globalThis.fetch = defaultFetch; pushes = []
  const ui = await mount(Dashboard); await selectGuild(ui)
  const trigger = ui.container.querySelector('[aria-label="ナビゲーションを開く"]')
  await click(trigger)
  const closeButton = ui.container.querySelector('[aria-label="ナビゲーションを閉じる"]')
  await act(async () => { closeButton.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true})); await pause() })
  const lastLink = ui.container.querySelector('dialog a[href="/account"]')
  assert.equal(document.activeElement,lastLink)
  await act(async () => { lastLink.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})); await pause() })
  assert.equal(document.activeElement,closeButton)
  await click(closeButton)
  for (const view of ['retention','health','diagnostics','channels','roles','insights']) {
    await click(trigger)
    assert.equal(trigger.getAttribute('aria-expanded'),'true')
    assert.equal(document.activeElement.getAttribute('aria-label'),'ナビゲーションを閉じる')
    const label = navigation.dashboardNavigation.find(i=>i.view===view).label[0]
    await click([...ui.container.querySelectorAll('dialog button')].find(e=>e.textContent===label))
    assert.equal(trigger.getAttribute('aria-expanded'),'false')
    assert.equal(document.activeElement,trigger)
    assert.equal(ui.container.querySelector('[data-view]').dataset.view,view)
    assert.equal(ui.container.querySelector('[data-guild]').dataset.guild,'guild-a')
    assert.equal(ui.container.querySelector('aside [aria-current="page"]').textContent,label)
  }
  await click(trigger); await click(ui.container.querySelector('dialog a[href="/dashboard/security/spam"]'))
  await click(trigger); await click(ui.container.querySelector('dialog a[href="/account"]'))
  assert.deepEqual(pushes,['/dashboard/security/spam','/account'])
  await ui.dispose()
})

test('feature search changes the existing view without navigating away or losing Guild', async () => {
  globalThis.fetch = defaultFetch; pushes = []
  const ui = await mount(Dashboard); await selectGuild(ui)
  const input = ui.container.querySelector('input[aria-label="検索"]')
  await act(async () => { input.dispatchEvent(new window.FocusEvent('focusin',{bubbles:true})); await pause() })
  const result = [...ui.container.querySelectorAll('button')].find(e=>e.querySelector('p')?.textContent==='アナリティクス')
  await click(result)
  assert.equal(ui.container.querySelector('h1').textContent,'アナリティクス')
  assert.equal(pushes.length,0)
  assert.match(ui.container.textContent,new RegExp(guilds[0].name))
  await ui.dispose()
})

test('display preferences keep edits across HTTP/network failures, prevent duplicates and retry', async () => {
  let mode = 'http'; let count = 0; let pending
  globalThis.fetch = async (url,options) => {
    if (options?.method === 'PATCH') { count++; if (mode==='http') return response({},500); if (mode==='network') throw Error('offline'); if (mode==='pending') return pending.promise; return response({}) }
    return defaultFetch(url)
  }
  const ui = await mount(Settings)
  const select = ui.container.querySelector('#timezone')
  await act(async()=>{ select.value='Europe/London'; select.dispatchEvent(new window.Event('change',{bubbles:true})); await pause() })
  const save = () => [...ui.container.querySelectorAll('button')].find(e=>/表示設定を保存|保存中/.test(e.textContent))
  await click(save()); assert.match(ui.container.textContent,/保存できませんでした/); assert.equal(select.value,'Europe/London'); assert.equal(save().disabled,false)
  mode='network'; await click(save()); assert.match(ui.container.textContent,/変更内容は保持/)
  mode='pending'; pending=deferred()
  await click(save()); assert.equal(save().disabled,true)
  await click(save()); assert.equal(count,3)
  await act(async()=>{ select.value='Asia/Seoul'; select.dispatchEvent(new window.Event('change',{bubbles:true})); pending.resolve(response({})); await pause() })
  assert.match(ui.container.textContent,/未保存の変更/); assert.equal(select.value,'Asia/Seoul')
  mode='success'; await click(save()); assert.match(ui.container.textContent,/表示設定を保存しました/); assert.doesNotMatch(ui.container.textContent,/保存できませんでした/)
  await ui.dispose()
})

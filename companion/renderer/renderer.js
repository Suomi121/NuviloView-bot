const form = document.querySelector('#presence-form')
const status = document.querySelector('#status')
const previewServer = document.querySelector('#preview-server')
const serverName = document.querySelector('#server-name')
const connect = document.querySelector('#connect')
const modeTabs = document.querySelectorAll('.mode-tab')
const aiForm = document.querySelector('#ai-form')
const aiKey = document.querySelector('#ai-key')
const aiModel = document.querySelector('#ai-model')
const aiPrompt = document.querySelector('#ai-prompt')
const aiAnswer = document.querySelector('#ai-answer')
const aiStatus = document.querySelector('#ai-status')
const askAi = document.querySelector('#ask-ai')
let aiProvider = 'openai'

function setMode(mode) {
  document.querySelector('#presence-view').classList.toggle('hidden', mode !== 'presence')
  document.querySelector('#ai-view').classList.toggle('hidden', mode !== 'ai')
  modeTabs.forEach((tab) => tab.classList.toggle('active', tab.dataset.mode === mode))
}

modeTabs.forEach((tab) => tab.addEventListener('click', () => setMode(tab.dataset.mode)))

serverName.addEventListener('input', () => {
  previewServer.textContent = serverName.value.trim() ? `${serverName.value.trim()} を分析中` : 'サーバーを分析中'
})

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  connect.disabled = true
  status.textContent = 'Discordに接続しています…'
  try {
    const clientId = document.querySelector('#client-id').value.trim()
    const result = await window.nuviloView.connect({ clientId, serverName: serverName.value.trim() })
    status.textContent = result.connected ? '接続中 — Discordプロフィールに表示されています。' : '接続できませんでした。'
    connect.textContent = '✓ 表示中（もう一度押すと更新）'
  } catch (error) {
    status.textContent = `接続できません: ${error.message || 'Discord Desktopが起動しているか確認してください。'}`
  } finally {
    connect.disabled = false
  }
})

document.querySelector('#dashboard').addEventListener('click', () => window.nuviloView.openDashboard())
document.querySelector('#minimize').addEventListener('click', () => window.nuviloView.minimize())
document.querySelector('#close').addEventListener('click', () => window.nuviloView.close())

document.querySelectorAll('.provider').forEach((button) => button.addEventListener('click', () => {
  aiProvider = button.dataset.provider
  document.querySelectorAll('.provider').forEach((item) => item.classList.toggle('active', item === button))
  aiModel.placeholder = aiProvider === 'gemini' ? 'gemini-3.5-flash' : 'gpt-5-mini'
  aiModel.value = ''
}))

aiForm.addEventListener('submit', async (event) => {
  event.preventDefault()
  askAi.disabled = true
  aiStatus.textContent = 'AIに問い合わせ中…'
  aiAnswer.textContent = ''
  try {
    const result = await window.nuviloView.askAi({ provider: aiProvider, apiKey: aiKey.value, model: aiModel.value, prompt: aiPrompt.value })
    aiAnswer.textContent = result.text
    aiStatus.textContent = '回答を受信しました（保存なし）'
  } catch (error) {
    aiAnswer.textContent = ''
    aiStatus.textContent = error.message || '回答を取得できませんでした。'
  } finally {
    askAi.disabled = false
  }
})

document.querySelector('#clear-ai').addEventListener('click', () => {
  aiKey.value = ''
  aiPrompt.value = ''
  aiAnswer.textContent = '入力とキーを消去しました。'
  aiStatus.textContent = 'この画面のメモリから消去済み'
})

window.nuviloView.onOpenAi(() => setMode('ai'))

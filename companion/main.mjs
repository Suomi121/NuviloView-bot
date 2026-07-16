import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { Client as DiscordRpcClient } from '@xhayper/discord-rpc'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DASHBOARD_URL = 'https://nuviloview-oem.vercel.app/dashboard'
let window
let rpc
let presenceStartedAt
const singleInstance = app.requestSingleInstanceLock()

if (!singleInstance) app.quit()

function showAi() {
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  window.webContents.send('app:open-ai')
}

function registerProtocol() {
  if (process.defaultApp) {
    // Electron development mode needs both the Electron executable and this app folder.
    app.setAsDefaultProtocolClient('nuviloview', process.execPath, [path.resolve(__dirname)])
    return
  }
  app.setAsDefaultProtocolClient('nuviloview')
}

function createWindow() {
  window = new BrowserWindow({
    width: 520,
    height: 760,
    minWidth: 460,
    minHeight: 680,
    frame: false,
    backgroundColor: '#effbff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  window.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

async function disconnectPresence() {
  if (!rpc) return
  try {
    await rpc.clearActivity()
    rpc.destroy()
  } catch {
    // Discord may already have closed its IPC connection.
  } finally {
    rpc = undefined
  }
}

async function connectPresence({ clientId, serverName }) {
  if (!/^\d{17,20}$/.test(clientId)) {
    throw new Error('DDPのApplication ID（数字のみ）を入力してください。')
  }

  await disconnectPresence()
  rpc = new DiscordRpcClient({ clientId })
  presenceStartedAt = new Date()

  await rpc.login()
  await rpc.user.setActivity({
    details: serverName ? `${serverName} を分析中` : 'サーバーを分析中',
    state: 'NuviloView Companion',
    startTimestamp: presenceStartedAt,
    largeImageKey: 'nuviloview_logo',
    largeImageText: 'NuviloView',
    buttons: [{ label: 'ダッシュボードを開く', url: DASHBOARD_URL }],
    instance: false,
  })

  return { connected: true, startedAt: presenceStartedAt.toISOString() }
}

ipcMain.handle('presence:connect', async (_event, settings) => connectPresence(settings))
ipcMain.handle('presence:disconnect', async () => {
  await disconnectPresence()
  return { connected: false }
})
ipcMain.handle('app:openDashboard', () => shell.openExternal(DASHBOARD_URL))
ipcMain.handle('ai:ask', async (_event, input) => {
  const provider = input?.provider === 'gemini' ? 'gemini' : 'openai'
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : ''
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : ''
  const model = typeof input?.model === 'string' ? input.model.trim() : ''
  if (!apiKey || !prompt) throw new Error('APIキーと質問を入力してください。')
  if (prompt.length > 12_000) throw new Error('質問は12,000文字以内にしてください。')
  if (model && !/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new Error('モデル名の形式が正しくありません。')

  const instruction = 'あなたはNuviloViewのAIアシスタントです。Discordコミュニティ運営・分析を、簡潔で実用的な日本語で支援してください。ユーザーが入力していないサーバーデータは推測しないでください。'
  let response
  if (provider === 'gemini') {
    const selectedModel = model || 'gemini-3.5-flash'
    response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: instruction }] }, contents: [{ role: 'user', parts: [{ text: prompt }] }] }),
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) throw new Error(data?.error?.message || `Gemini API error (${response.status})`)
    const text = data?.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('').trim()
    if (!text) throw new Error('Geminiから回答を取得できませんでした。')
    return { text }
  }

  const selectedModel = model || 'gpt-5-mini'
  response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: selectedModel, store: false, instructions: instruction, input: prompt }),
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error?.message || `OpenAI API error (${response.status})`)
  const text = data?.output_text || data?.output?.flatMap((item) => item.content ?? []).filter((part) => part.type === 'output_text').map((part) => part.text).join('').trim()
  if (!text) throw new Error('OpenAIから回答を取得できませんでした。')
  return { text }
})
ipcMain.handle('window:minimize', () => window?.minimize())
ipcMain.handle('window:close', () => window?.close())

app.whenReady().then(() => {
  registerProtocol()
  createWindow()
  if (process.argv.includes('nuviloview://ai')) setTimeout(showAi, 300)
})
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (url === 'nuviloview://ai') showAi()
})
app.on('second-instance', (_event, commandLine) => {
  if (commandLine.includes('nuviloview://ai')) showAi()
})
app.on('window-all-closed', async () => {
  await disconnectPresence()
  if (process.platform !== 'darwin') app.quit()
})

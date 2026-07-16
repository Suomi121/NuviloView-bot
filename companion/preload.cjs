const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('nuviloView', {
  connect: (settings) => ipcRenderer.invoke('presence:connect', settings),
  disconnect: () => ipcRenderer.invoke('presence:disconnect'),
  askAi: (input) => ipcRenderer.invoke('ai:ask', input),
  openDashboard: () => ipcRenderer.invoke('app:openDashboard'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  close: () => ipcRenderer.invoke('window:close'),
  onOpenAi: (callback) => ipcRenderer.on('app:open-ai', callback),
})

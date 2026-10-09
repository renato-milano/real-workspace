const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  serverInfo: () => ipcRenderer.invoke('server-info'),
  setOpenWindows: (sourceIds) => ipcRenderer.send('open-windows', sourceIds),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});

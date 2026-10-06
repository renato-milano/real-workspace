const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  serverInfo: () => ipcRenderer.invoke('server-info'),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});

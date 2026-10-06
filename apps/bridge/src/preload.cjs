const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  listSources: () => ipcRenderer.invoke('list-sources'),
  serverInfo: () => ipcRenderer.invoke('server-info'),
  setActiveSource: (sourceId) => ipcRenderer.send('active-source', sourceId),
  onLog: (cb) => ipcRenderer.on('log', (_e, line) => cb(line)),
});

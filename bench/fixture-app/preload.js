'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('fixture', {
  init: () => ipcRenderer.invoke('fixture:init'),
  click: (hit) => ipcRenderer.send('fixture:click', hit),
  event: (record) => ipcRenderer.send('fixture:event', record),
  rendered: (snapshot) => ipcRenderer.send('fixture:rendered', snapshot),
  onCommand: (fn) => ipcRenderer.on('fixture:cmd', (_e, cmd) => fn(cmd)),
})

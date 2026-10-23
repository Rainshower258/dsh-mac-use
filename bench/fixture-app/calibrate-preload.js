'use strict'
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('calib', {
  markers: (list) => ipcRenderer.send('calib:markers', list),
  click: (hit) => ipcRenderer.send('calib:click', hit),
  texts: (list) => ipcRenderer.send('calib:texts', list),
  onLines: (fn) => ipcRenderer.on('calib:lines', (_e, lines) => fn(lines)),
  onFields: (fn) => ipcRenderer.on('calib:fields', (_e, fields) => fn(fields)),
  event: (e) => ipcRenderer.send('calib:event', e),
  values: (v) => ipcRenderer.send('calib:values', v),
})

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('petAPI', {
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: () => ipcRenderer.send('drag-move'),
  dragEnd: () => ipcRenderer.send('drag-end'),
  openMenu: () => ipcRenderer.send('context-menu'),
  onInteract: (cb) => ipcRenderer.on('interact', (_e, kind) => cb(kind)),
  onScale: (cb) => ipcRenderer.on('set-scale', (_e, s) => cb(s)),
  onSkin: (cb) => ipcRenderer.on('set-skin', (_e, v) => cb(v)),
  skinChanged: (v) => ipcRenderer.send('skin-changed', v),
  onShowIntro: (cb) => ipcRenderer.on('show-intro', () => cb()),
  /** 渲染端定期上报画布 alpha 遮罩，主进程据此做像素级点击穿透 */
  hitMask: (m) => ipcRenderer.send('hit-mask', m),
  /** 点击消息气泡：跳转到飞书对应会话 */
  openChat: (chatId) => ipcRenderer.send('open-chat', chatId),
  /** 双击宠物打开小绝助手 */
  openAssistant: () => ipcRenderer.send('open-assistant'),
  /** 悬停概览出现时临时扩大透明宠物窗口，收起后恢复原尺寸 */
  resizePetOverview: (expanded) => ipcRenderer.send('pet-overview-resize', Boolean(expanded)),
  /** file:// 宠物页通过主进程读取本地工作台，避免跨协议 CORS。 */
  loadPetOverview: (range) => ipcRenderer.invoke('pet-overview-load', range),
  closeAssistant: () => ipcRenderer.send('assistant-close'),
  resizeAssistant: (expanded) => ipcRenderer.send('assistant-resize', Boolean(expanded)),
  openWorkbench: () => ipcRenderer.send('open-workbench'),
  openApproval: (approval) => ipcRenderer.send('open-approval', approval),
  openWorkbenchApproval: (instanceCode) => ipcRenderer.send('open-workbench-approval', instanceCode),
})

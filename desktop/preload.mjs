import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('desktopMeta', {
  platform: process.platform,
});

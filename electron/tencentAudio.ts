import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { app, ipcMain, type WebContents } from 'electron';
import { IPC } from '../shared/protocol';

// Each capture owns its child. A preview handing off to a live class can
// release its own tap without closing the newly opened one.
export function registerTencentAudio(isCaptureWindow: (contents: WebContents) => boolean): void {
  const active = new Map<string, () => void>();
  ipcMain.handle(IPC.tencentAudioStart, (event, id: string) => {
    const sender = event.sender;
    const key = sender.id + ':' + id;
    if (!isCaptureWindow(sender) || process.platform !== 'darwin' || typeof id !== 'string' || active.has(key))
      throw new Error('Tencent audio capture unavailable');
    const binary = app.isPackaged ? join(process.resourcesPath, 'native', 'tencent-audio')
      : join(app.getAppPath(), 'out', 'native', 'tencent-audio');
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.stdin.end();
    };
    active.set(key, stop);
    sender.once('destroyed', stop);
    child.stdin.on('error', () => {});
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { stop(); reject(new Error('腾讯会议直采启动超时，请检查系统录音权限。')); }, 30_000);
      let ready = false;
      let detail = '';
      createInterface({ input: child.stderr }).on('line', line => {
        if (line === 'READY') {
          ready = true;
          clearTimeout(timeout);
          resolve();
        } else detail = line.slice(-500);
      });
      let pending = Buffer.alloc(0);
      child.stdout.on('data', (chunk: Buffer) => {
        if (stopped || sender.isDestroyed()) return;
        pending = Buffer.concat([pending, chunk]);
        // The existing worklet produces 100 ms of 16 kHz Float32 PCM.
        while (pending.length >= 6400) {
          sender.send(IPC.tencentAudioData, id, new Uint8Array(pending.subarray(0, 6400)));
          pending = pending.subarray(6400);
        }
      });
      child.once('error', error => { detail = error.message; });
      child.once('close', () => {
        clearTimeout(timeout);
        active.delete(key);
        sender.removeListener('destroyed', stop);
        const message = detail || '腾讯会议音频采集已结束';
        if (!ready) reject(new Error(message));
        else if (!stopped && !sender.isDestroyed()) sender.send(IPC.tencentAudioData, id, message);
      });
    });
  });
  ipcMain.on(IPC.tencentAudioStop, (event, id: string) => {
    if (isCaptureWindow(event.sender)) active.get(event.sender.id + ':' + id)?.();
  });
  app.on('before-quit', () => { for (const stop of active.values()) stop(); });
}

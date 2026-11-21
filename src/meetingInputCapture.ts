import { MicCapture } from './audio/micCapture';

export const TENCENT_PLAYBACK = 'meetingcopilot:tencent-playback';

export class MeetingInputCapture extends MicCapture {
  private disconnect?: () => void;
  private direct = false;
  constructor(private readonly onEnded: (error: string) => void,
    private readonly api: Pick<typeof window.mc, 'startTencentAudio' | 'stopTencentAudio' | 'onTencentAudio'> = window.mc) {
    super();
  }

  override get running() { return this.direct || super.running; }
  override get deviceLabel() { return this.direct ? '腾讯会议直采' : super.deviceLabel; }

  override async start(deviceId: string | undefined, onPcm: (buf: ArrayBuffer, ts: number) => void,
    options: { audioProcessing?: boolean } = {}): Promise<void> {
    if (deviceId !== TENCENT_PLAYBACK) return super.start(deviceId, onPcm, options);
    if (this.disconnect) return;
    const id = crypto.randomUUID();
    const off = this.api.onTencentAudio(id, (data) => {
      if (typeof data === 'string') {
        void this.stop();
        this.onEnded(data);
      } else onPcm(data, Date.now());
    });
    const cleanup = () => { off(); this.api.stopTencentAudio(id); };
    this.disconnect = cleanup;
    try {
      await this.api.startTencentAudio(id);
      if (this.disconnect !== cleanup) throw new Error('Audio capture start cancelled');
      this.direct = true;
    } catch (error) {
      if (this.disconnect === cleanup) await this.stop();
      throw error;
    }
  }

  override async stop(): Promise<void> {
    this.disconnect?.();
    this.disconnect = undefined;
    this.direct = false;
    await super.stop();
  }
}

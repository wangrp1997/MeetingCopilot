import { useEffect, useRef, useState, type RefObject } from 'react';
import { useT } from '../i18n';
import { MeetingInputCapture } from '../meetingInputCapture';
import { rmsOf } from '../audio/level';

export interface InputReading { peak: number; frames: number }

export function InputLevel({ capturing, asrReady, deviceId, deviceLabel, live, sentences }: {
  capturing: boolean;
  asrReady: boolean;
  deviceId?: string;
  deviceLabel: string;
  live: RefObject<InputReading>;
  sentences: number;
}) {
  const t = useT().transcript;
  const [testing, setTesting] = useState(false);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [db, setDb] = useState<number | null>(null);
  const [frames, setFrames] = useState(false);
  const feedAsr = useRef(false);
  feedAsr.current = asrReady && !capturing;
  const preview = useRef<InputReading>({ peak: 0, frames: 0 });
  useEffect(() => {
    if (capturing) setTesting(false);
    if (!testing || capturing) return;
    let disposed = false;
    const cap = new MeetingInputCapture(message => {
      if (!disposed) { setTesting(false); setError(message); }
    });
    setError('');
    setLabel('');
    let sentAudio = false;
    void cap.start(deviceId || undefined, (buf, ts) => {
      preview.current.peak = Math.max(preview.current.peak, rmsOf(buf));
      preview.current.frames++;
      if (feedAsr.current) {
        sentAudio = true;
        window.mc.sendPcm(buf, ts, 'them');
      }
    }, { audioProcessing: false }).then(() => {
      if (!disposed) setLabel(cap.deviceLabel);
    }).catch((e: Error) => {
      if (!disposed) { setTesting(false); setError(e.message); }
    });
    return () => {
      disposed = true;
      void cap.stop();
      if (sentAudio) window.mc.finishInputTest();
    };
  }, [capturing, testing, deviceId]);

  useEffect(() => {
    setDb(null);
    setFrames(false);
    const reading = capturing ? live.current : preview.current;
    reading.peak = 0;
    reading.frames = 0;
    if (!testing && !capturing) return;
    const timer = setInterval(() => {
      setDb(reading.peak ? Math.round(20 * Math.log10(reading.peak)) : null);
      setFrames(reading.frames > 0);
      reading.peak = 0;
      reading.frames = 0;
    }, 250);
    return () => clearInterval(timer);
  }, [capturing, testing, live]);

  const active = capturing || testing;
  const name = (testing ? label : deviceLabel) || t.meetingInput;
  const value = !active ? t.levelIdle : !frames ? t.waitFrames : db === null ? t.noSignal : `${db} dBFS`;
  return <div className="input-level">
    <span>{name}</span>
    <meter aria-label={t.meetingInput} min={-60} max={0} value={db ?? -60} />
    <span className="input-reading">{value}</span>
    <span>{active ? (asrReady ? t.lineCount(sentences) : t.asrPending) : t.transcriptIdle}</span>
    {!capturing && <button className="btn btn-sm" aria-pressed={testing} onClick={() => setTesting(v => !v)}>
      {testing ? t.endTest : t.testInput}
    </button>}
    {error && !capturing && <span role="alert">{error}</span>}
  </div>;
}

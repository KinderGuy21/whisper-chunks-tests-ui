import React, { useEffect, useRef, useState } from 'react';
import { getSupportedMimeTypes, now } from './utils';
import { finalizeSession, uploadChunk } from './requests';

// Type definition for log items
type LogItem = { ts: string; msg: string };
type PersistedSession = {
  status: 'active' | 'ready';
  sessionId: string;
  seq: number;
  startMs: number;
  timesliceMs: number;
  therapistId: string;
  patientId: string;
  organizationId: string;
  appointmentId: string;
  updatedAt: number;
};

const STORAGE_KEY = 'dive.recorder.session.v1';

function loadPersisted(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as PersistedSession;
  } catch {
    return null;
  }
}
function clearPersisted() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

/**
 * Main application component for the audio recorder.
 */
export default function App() {
  const [sessionId, setSessionId] = useState<string>(() =>
    Math.random().toString(36).slice(2)
  );
  const [methodType, setMethodType] = useState<string>('GENERAL');
  const [timesliceMs, setTimesliceMs] = useState<number>(100000);
  const [isPaused, setIsPaused] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [seq, setSeq] = useState(0);
  const [chunksSent, setChunksSent] = useState<number>(0);
  const [errors, setErrors] = useState<number>(0);
  const [log, setLog] = useState<LogItem[]>([]);
  const [therapistId, setTherapistId] = useState<string>('150');
  const [patientId, setPatientId] = useState<string>('150');
  const [organizationId, setOrganizationId] = useState<string>('150');
  const [appointmentId, setAppointmentId] = useState<string>('150');

  // Mode: mic vs file
  const [mode, setMode] = useState<'mic' | 'file'>('mic');
  const [playbackRate, setPlaybackRate] = useState<number>(1);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const fileUrlRef = useRef<string | null>(null);

  // Refs to hold mutable data without causing re-renders
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const startMsRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);

  /**
   * Pushes a new message to the log state.
   * @param msg The message to log.
   */
  function pushLog(msg: string) {
    setLog((l) => [{ ts: now(), msg }, ...l].slice(0, 500));
  }

  function persistFromState(overrides: Partial<PersistedSession> = {}) {
    const data: PersistedSession = {
      status: 'active',
      sessionId,
      seq: seqRef(),
      startMs: startMsRef.current,
      timesliceMs,
      therapistId,
      patientId,
      organizationId,
      appointmentId,
      updatedAt: Date.now(),
      ...overrides,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Ignore quota errors
    }
  }
  /**
   * Starts a new MediaRecorder instance and sets up its ondataavailable handler.
   * This function is the core of the recording loop.
   */
  async function startNewRecorder() {
    if (!audioStreamRef.current || !runningRef.current) {
      pushLog('Stopping recorder loop.');
      return;
    }

    try {
      const mimeType = getSupportedMimeTypes()[0];
      const mr = new MediaRecorder(
        audioStreamRef.current,
        mimeType ? { mimeType } : undefined
      );

      mr.ondataavailable = async (evt: BlobEvent) => {
        // handle this event only once for this recorder
        mr.ondataavailable = null;

        const shouldContinue = runningRef.current;

        const chunk = evt.data;
        if (chunk && chunk.size > 0) {
          const currentSeq = seqRef();
          const startMs = startMsRef.current;
          const endMs = startMs + timesliceMs;
          const nextSeq = currentSeq + 1;

          try {
            await uploadChunk({
              chunk,
              sessionId,
              seq: currentSeq,
              startMs,
              endMs,
              therapistId,
              patientId,
              appointmentId,
              organizationId,
            });
            setChunksSent((c) => c + 1);
            persistFromState({ seq: nextSeq, startMs: endMs });
            pushLog(`Uploaded seq=${currentSeq} bytes=${chunk.size}`);
          } catch (e: any) {
            setErrors((x) => x + 1);
            pushLog('Upload error: ' + (e?.message || e));
          }

          startMsRef.current = endMs;
          setSeq(nextSeq);
        }

        if (shouldContinue) {
          startNewRecorder();
        } else {
          persistFromState({ status: 'ready' });
          setIsReady(true);
        }
      };

      mediaRecorderRef.current = mr;
      mr.start(timesliceMs);
      pushLog(`Recorder for seq=${seqRef()} started.`);
    } catch (err: any) {
      pushLog('Recorder creation error: ' + (err?.message || err));
    }
  }

  /**
   * Starts the initial audio recording process.
   */
  async function startRecording() {
    if (mode === 'file') {
      await startFileProcessing();
      return;
    }
    try {
      const persisted = loadPersisted();
      const isResuming =
        !!persisted &&
        persisted.status === 'active' &&
        persisted.sessionId === sessionId &&
        persisted.seq >= 0;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

      runningRef.current = true;
      setIsRecording(true);
      setIsPaused(false);

      if (isResuming) {
        startMsRef.current = persisted!.startMs;
        setSeq(persisted!.seq);
        setTimesliceMs(persisted!.timesliceMs || timesliceMs);
        setTherapistId(persisted!.therapistId);
        setPatientId(persisted!.patientId);
        setOrganizationId(persisted!.organizationId);
        setAppointmentId(persisted!.appointmentId);
        pushLog(
          `Resuming session ${persisted!.sessionId} at seq=${persisted!.seq}`
        );
        persistFromState();
      } else {
        startMsRef.current = Date.now();
        setSeq(0);
        setChunksSent(0);
        setErrors(0);
        pushLog('Recording started');
        persistFromState({
          status: 'active',
          seq: 0,
          startMs: startMsRef.current,
        });
      }

      // Start the first recorder
      startNewRecorder();
    } catch (err: any) {
      pushLog('Mic error: ' + (err?.message || err));
    }
  }

  async function startFileProcessing() {
    try {
      const file = fileInputRef.current?.files?.[0];
      if (!file) {
        pushLog('Please choose an audio file first.');
        return;
      }

      // Prepare audio element to play file, capture stream
      if (fileUrlRef.current) {
        URL.revokeObjectURL(fileUrlRef.current);
        fileUrlRef.current = null;
      }
      const url = URL.createObjectURL(file);
      fileUrlRef.current = url;

      let audioEl = audioElRef.current;
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioElRef.current = audioEl;
      }
      audioEl.src = url;
      audioEl.crossOrigin = 'anonymous';
      audioEl.preload = 'auto';
      audioEl.playbackRate = playbackRate || 1;
      audioEl.muted = true; // avoid feedback

      // Some browsers require metadata before captureStream becomes available
      await new Promise<void>((resolve) => {
        const onMeta = () => {
          audioEl!.removeEventListener('loadedmetadata', onMeta);
          resolve();
        };
        audioEl!.addEventListener('loadedmetadata', onMeta);
      });

      const stream =
        (audioEl as any).captureStream?.() ||
        (audioEl as any).mozCaptureStream?.();
      if (!stream) {
        pushLog('captureStream is not supported in this browser.');
        return;
      }
      audioStreamRef.current = stream as MediaStream;

      runningRef.current = true;
      setIsRecording(true);
      setIsPaused(false);

      // For file playback, we start at t=0 and advance by timesliceMs
      startMsRef.current = 0;
      setSeq(0);
      setChunksSent(0);
      setErrors(0);
      pushLog('File chunking started');
      persistFromState({ status: 'active', seq: 0, startMs: 0 });

      // Start stream playback and recording loop
      await audioEl.play();
      startNewRecorder();
    } catch (err: any) {
      pushLog('File processing error: ' + (err?.message || err));
    }
  }

  /**
   * Toggles the pause/unpause state of the recording process.
   */
  async function pauseUnpauseRecording() {
    if (!mediaRecorderRef.current) {
      console.warn('MediaRecorder is not initialized.');
      return;
    }

    if (mediaRecorderRef.current.state === 'recording') {
      // If currently recording, pause it
      mediaRecorderRef.current.pause();
      pushLog('Recording paused');
      setIsPaused(true);
      // Do NOT stop audio tracks here, as that would end the stream.
    } else if (mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      pushLog('Recording resumed');
    } else {
      console.warn(
        `MediaRecorder is in an unexpected state: ${mediaRecorderRef.current.state}`
      );
    }
  }

  /**
   * Stops the recording, ensures the final chunk is uploaded,
   * releases the microphone, and notifies the backend.
   */
  function stopRecording() {
    if (!mediaRecorderRef.current) {
      pushLog('No recording is active to stop.');
      return;
    }

    pushLog('Stopping and finalizing recording...');
    setIsRecording(false);

    // stop the loop first - we’ll still upload the final chunk
    runningRef.current = false;

    // trigger the final ondataavailable
    if (mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    // release mic or file stream
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
    }
    // Stop file playback and cleanup URL
    if (audioElRef.current) {
      try {
        audioElRef.current.pause();
      } catch {}
    }
    if (fileUrlRef.current) {
      URL.revokeObjectURL(fileUrlRef.current);
      fileUrlRef.current = null;
    }
  }
  async function finalize() {
    try {
      pushLog('Finalize call completed.');
      await finalizeSession({
        sessionId,
        therapistId,
        patientId,
        organizationId,
        appointmentId,
        methodType,
      });
      pushLog('Finalize call completed.');

      // Clear persistence
      clearPersisted();
      mediaRecorderRef.current = null;
    } catch (err: any) {
      pushLog('Finalize error: ' + (err?.message || err));
    }
  }

  // stable ref for seq inside ondataavailable
  const seqBox = useRef<number>(0);
  function seqRef() {
    return seqBox.current;
  }
  useEffect(() => {
    seqBox.current = seq;
  }, [seq]);

  useEffect(() => {
    const p = loadPersisted();
    if ((p && p.status === 'active') || p?.status === 'ready') {
      setSessionId(p.sessionId);
      setTherapistId(p.therapistId);
      setPatientId(p.patientId);
      setOrganizationId(p.organizationId);
      setAppointmentId(p.appointmentId);
      setIsReady(p.status === 'ready');
      setTimesliceMs(p.timesliceMs || timesliceMs);
      startMsRef.current = p.startMs;
      setSeq(p.seq);
      pushLog(
        `Recovered active session ${p.sessionId} (seq=${p.seq}). Click Start to continue.`
      );
    }
    // When the page is being unloaded, keep the latest pointers if we were recording
    const beforeUnload = () => {
      if (runningRef.current) {
        persistFromState();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className='wrap'>
      <div className='card'>
        <h1>Audio Chunker POC</h1>
        <div className='row'>
          <div>
            <label>Session ID</label>
            <input
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
          </div>
        </div>
        <div
          className='row-3'
          style={{ marginTop: 12 }}
        >
          <div>
            <label>Mode</label>
            <div>
              <label style={{ marginRight: 8 }}>
                <input
                  type='radio'
                  checked={mode === 'mic'}
                  onChange={() => setMode('mic')}
                />
                Mic
              </label>
              <label>
                <input
                  type='radio'
                  checked={mode === 'file'}
                  onChange={() => setMode('file')}
                />
                File
              </label>
            </div>
          </div>
          {mode === 'file' && (
            <div>
              <label>Audio File</label>
              <input
                type='file'
                accept='audio/*'
                ref={fileInputRef}
              />
            </div>
          )}
          {mode === 'file' && (
            <div>
              <label>Playback Rate</label>
              <input
                type='number'
                min={0.1}
                step={0.1}
                value={playbackRate}
                onChange={(e) => setPlaybackRate(Number(e.target.value))}
              />
            </div>
          )}
        </div>
        <div
          className='row-3'
          style={{ marginTop: 12 }}
        >
          <div>
            <label>Therapist ID</label>
            <input
              value={therapistId}
              onChange={(e) => setTherapistId(e.target.value)}
            />
          </div>
          <div>
            <label>Patient ID</label>
            <input
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
            />
          </div>
          <div>
            <label>Organization ID</label>
            <input
              value={organizationId}
              onChange={(e) => setOrganizationId(e.target.value)}
            />
          </div>
        </div>
        <div
          className='row-3'
          style={{ marginTop: 12 }}
        >
          <div>
            <label>Appointment ID</label>
            <input
              value={appointmentId}
              onChange={(e) => setAppointmentId(e.target.value)}
            />
          </div>
          <div>
            <label>Method</label>
            <select
              value={methodType}
              onChange={(e) => setMethodType(e.target.value)}
            >
              <option value='GENERAL'>GENERAL</option>
              <option value='INTAKE'>INTAKE</option>
              <option value='GENERAL_PSYCHIATRIC'>GENERAL PSY</option>
            </select>
          </div>
          <div></div>
        </div>
        <div
          className='row-3'
          style={{ marginTop: 12 }}
        >
          <div>
            <label>Timeslice (ms)</label>
            <input
              type='number'
              value={timesliceMs}
              min={1000}
              step={500}
              onChange={(e) => setTimesliceMs(Number(e.target.value))}
            />
          </div>
        </div>

        <div className='toolbar'>
          {!isReady && (
            <>
              <button
                className='primary'
                onClick={isRecording ? pauseUnpauseRecording : startRecording}
              >
                {isPaused ? 'Unpause' : isRecording ? 'Pause' : 'Start'}
              </button>
              <button
                disabled={!isRecording}
                onClick={stopRecording}
              >
                Stop
              </button>
            </>
          )}
          {isReady && methodType && (
            <button onClick={finalize}>Finalize</button>
          )}
          <button
            onClick={() => {
              clearPersisted();
              setIsReady(false);
            }}
          >
            clear persisted
          </button>
          <span className='pill'>sent: {chunksSent}</span>
          <span className='pill'>errors: {errors}</span>
          <span className='pill'>seq: {seq}</span>
        </div>

        <div className='grid'>
          <div>
            <div
              className='small'
              style={{ margin: '12px 0 6px' }}
            >
              Notes
            </div>
            <ul className='small'>
              <li>Requires HTTPS or localhost for mic access.</li>
              <li>
                This solution uploads complete files with headers for each
                chunk.
              </li>
              <li>The backend must expose POST /upload-chunk and /finalize.</li>
              <li>
                File mode uses HTMLMediaElement.captureStream to produce valid
                chunk containers during playback. Increase Playback Rate to
                speed up processing.
              </li>
            </ul>
          </div>
          <div>
            <div
              className='small'
              style={{ margin: '12px 0 6px' }}
            >
              Status log
            </div>
            <div className='log'>
              {log.map((l, i) => (
                <div key={i}>
                  [{l.ts}] {l.msg}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

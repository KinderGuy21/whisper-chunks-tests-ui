import React, { useEffect, useRef, useState } from 'react';
import { getSupportedMimeTypes, now } from './utils';
import { finalizeSession, uploadChunk } from './requests';

// Type definition for log items
type LogItem = { ts: string; msg: string };
type PersistedSession = {
  active: boolean;
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
  const [timesliceMs, setTimesliceMs] = useState<number>(100000);
  const [isPaused, setIsPaused] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [seq, setSeq] = useState(0);
  const [chunksSent, setChunksSent] = useState<number>(0);
  const [errors, setErrors] = useState<number>(0);
  const [log, setLog] = useState<LogItem[]>([]);
  const [therapistId, setTherapistId] = useState<string>('150');
  const [patientId, setPatientId] = useState<string>('150');
  const [organizationId, setOrganizationId] = useState<string>('150');
  const [appointmentId, setAppointmentId] = useState<string>('150');

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
      active: true,
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
        // Detach the handler to prevent any possibility of it being called again.
        mr.ondataavailable = null;

        if (!runningRef.current) return;

        const chunk = evt.data;
        if (chunk && chunk.size > 0) {
          const currentSeq = seqRef();
          const startMs = startMsRef.current;
          const endMs = startMs + timesliceMs;
          const nextSeq = currentSeq + 1;

          try {
            console.log('chunk number:', currentSeq);
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

          // Advance sequence and timeline for the *next* recorder
          startMsRef.current = endMs;
          setSeq(nextSeq);
        }

        // Immediately start the next recorder to ensure seamless recording.
        if (runningRef.current) {
          startNewRecorder();
        }
      };

      // Stop the *previous* recorder, if one exists and is active.
      // This is what triggers the ondataavailable for the previous chunk,
      // which will then upload its data.
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === 'recording'
      ) {
        mediaRecorderRef.current.stop();
      }

      // 4. Update the ref to point to our new recorder and start it.
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
    try {
      const persisted = loadPersisted();
      const isResuming =
        !!persisted &&
        persisted.active &&
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
          active: true,
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
  async function stopAndFinalizeRecording() {
    if (!mediaRecorderRef.current) {
      pushLog('No recording is active to stop.');
      return;
    }

    pushLog('Stopping and finalizing recording...');
    setIsRecording(false);

    // Signal the loop to stop, then stop the current recorder to flush final dataavailable
    runningRef.current = false;

    if (mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    // Release mic
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
    }

    try {
      await finalizeSession({
        sessionId,
        therapistId,
        patientId,
        organizationId,
        appointmentId,
      });
      pushLog('Finalize call completed.');
    } catch (e: any) {
      pushLog('Finalize error: ' + (e?.message || e));
    } finally {
      // Clear persistence
      clearPersisted();
      mediaRecorderRef.current = null;
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
    if (p && p.active) {
      setSessionId(p.sessionId);
      setTherapistId(p.therapistId);
      setPatientId(p.patientId);
      setOrganizationId(p.organizationId);
      setAppointmentId(p.appointmentId);
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

  // Keep storage in sync if user edits ids or timeslice mid-recording
  useEffect(() => {
    if (isRecording || loadPersisted()?.active) {
      persistFromState();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionId,
    therapistId,
    patientId,
    organizationId,
    appointmentId,
    timesliceMs,
  ]);

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
        <div className='row-3' style={{ marginTop: 12 }}>
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
        <div className='row-3' style={{ marginTop: 12 }}>
          <div>
            <label>Appointment ID</label>
            <input
              value={appointmentId}
              onChange={(e) => setAppointmentId(e.target.value)}
            />
          </div>
          <div></div>
          <div></div>
        </div>
        <div className='row-3' style={{ marginTop: 12 }}>
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
          <button
            className='primary'
            onClick={isRecording ? pauseUnpauseRecording : startRecording}
          >
            {isPaused ? 'Unpause' : isRecording ? 'Pause' : 'Start'}
          </button>
          <button disabled={!isRecording} onClick={stopAndFinalizeRecording}>
            Finalize
          </button>
          <span className='pill'>sent: {chunksSent}</span>
          <span className='pill'>errors: {errors}</span>
          <span className='pill'>seq: {seq}</span>
        </div>

        <div className='grid'>
          <div>
            <div className='small' style={{ margin: '12px 0 6px' }}>
              Notes
            </div>
            <ul className='small'>
              <li>Requires HTTPS or localhost for mic access.</li>
              <li>
                This solution uploads complete files with headers for each
                chunk.
              </li>
              <li>The backend must expose POST /upload-chunk and /finalize.</li>
            </ul>
          </div>
          <div>
            <div className='small' style={{ margin: '12px 0 6px' }}>
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

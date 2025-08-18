import React, { useEffect, useRef, useState } from 'react';

// Type definition for log items
type LogItem = { ts: string; msg: string };

/**
 * Returns the current time formatted as a string.
 */
function now() {
  return new Date().toLocaleTimeString();
}

/**
 * Main application component for the audio recorder.
 */
export default function App() {
  const [backend, setBackend] = useState<string>('http://localhost:3000');
  const [sessionId, setSessionId] = useState<string>(() =>
    Math.random().toString(36).slice(2)
  );
  const [timesliceMs, setTimesliceMs] = useState<number>(100000);
  const [mimeType, setMimeType] = useState<string>('audio/webm;codecs=opus');
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

  /**
   * Checks if a given mime type is supported by the browser.
   * @param mt The mime type string.
   * @returns A boolean indicating support.
   */
  function supportsMimeType(mt: string) {
    return (
      typeof MediaRecorder !== 'undefined' &&
      (MediaRecorder.isTypeSupported?.(mt) ?? true)
    );
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
      const mt = supportsMimeType(mimeType) ? mimeType : undefined;
      // 1. Create the new recorder instance
      const mr = new MediaRecorder(
        audioStreamRef.current,
        mt ? ({ mimeType: mt } as MediaRecorderOptions) : undefined
      );

      // 2. The ondataavailable handler will process the current chunk
      //    and then recursively call startNewRecorder to continue the chain.
      mr.ondataavailable = async (evt: BlobEvent) => {
        // Detach the handler to prevent any possibility of it being called again.
        mr.ondataavailable = null;

        if (!runningRef.current) return;

        const chunk = evt.data;
        if (chunk && chunk.size > 0) {
          const currentSeq = seqRef();
          const startMs = startMsRef.current;
          const endMs = startMs + timesliceMs;

          try {
            await uploadBlob(chunk, currentSeq, startMs, endMs);
            setChunksSent((c) => c + 1);
            pushLog(`Uploaded seq=${currentSeq} bytes=${chunk.size}`);
          } catch (e: any) {
            setErrors((x) => x + 1);
            pushLog('Upload error: ' + (e?.message || e));
          }

          // Advance sequence and timeline for the *next* recorder
          startMsRef.current = endMs;
          setSeq((s) => s + 1);
        }

        // 3. Immediately start the next recorder to ensure seamless recording.
        //    This call creates the next link in the chain.
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
      // Get the audio stream and store it in a ref. This stream will be reused.
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStreamRef.current = stream;

      // Reset state and refs
      startMsRef.current = Date.now();
      runningRef.current = true;
      setSeq(0);
      setChunksSent(0);
      setErrors(0);
      setIsRecording(true);
      pushLog('Recording started');

      // Start the first recorder
      startNewRecorder();
    } catch (err: any) {
      pushLog('Mic error: ' + (err?.message || err));
    }
  }

  /**
   * Toggles the pause/unpause state of the recording process.
   * Assumes mediaRecorderRef.current and audioStreamRef.current are already set up
   * and the recording has been started.
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
      // If currently paused, resume it
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      pushLog('Recording resumed');
    } else {
      // Handle other states like 'inactive' or 'stopped' if necessary,
      // though typically this function would only be called when recording is active.
      console.warn(
        `MediaRecorder is in an unexpected state: ${mediaRecorderRef.current.state}`
      );
    }
  }

  /**
   * Finalizes the session on the backend.
   */
  async function finalize() {
    pushLog('Calling finalize endpoint...');
    try {
      const res = await fetch(`${backend}/finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          therapistId,
          patientId,
          organizationId,
          appointmentId,
        }),
      });
      if (!res.ok)
        throw new Error(
          `Server responded with ${res.status}: ${await res.text()}`
        );

      const j = await res.json();
      pushLog('Finalize successful: ' + JSON.stringify(j));
    } catch (e: any) {
      pushLog('Finalize error: ' + (e?.message || e));
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

    // 1. Signal the recording loop to stop.
    // The next ondataavailable handler will not start a new recorder.
    runningRef.current = false;

    // 2. Stop the current MediaRecorder. This will trigger one last
    // `ondataavailable` event to process and upload the final audio chunk.
    if (mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }

    // 3. Release the microphone and clean up the stream reference.
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((track) => track.stop());
      audioStreamRef.current = null;
    }

    // 4. Call the backend to finalize the session.
    await finalize();

    // Optional: Reset refs after finalization
    mediaRecorderRef.current = null;
  }

  /**
   * Uploads a single chunk of audio data to the backend.
   * @param blob The Blob object to upload.
   * @param seq The sequence number of the chunk.
   * @param startMs The start timestamp of the chunk.
   * @param endMs The end timestamp of the chunk.
   */
  async function uploadBlob(
    blob: Blob,
    seq: number,
    startMs: number,
    endMs: number
  ) {
    const fd = new FormData();
    fd.append('file', blob, `chunk-${seq}.webm`);
    fd.append('mimeType', blob.type);
    fd.append('sessionId', sessionId);
    fd.append('seq', String(seq));
    fd.append('startMs', String(startMs));
    fd.append('endMs', String(endMs));
    if (therapistId) fd.append('therapistId', therapistId);
    if (patientId) fd.append('patientId', patientId);
    if (organizationId) fd.append('organizationId', organizationId);
    if (appointmentId) fd.append('appointmentId', appointmentId);
    const res = await fetch(`${backend}/upload-chunk`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) throw new Error(await res.text());
  }

  // stable ref for seq inside ondataavailable
  const seqBox = useRef<number>(0);
  function seqRef() {
    return seqBox.current;
  }
  useEffect(() => {
    seqBox.current = seq;
  }, [seq]);

  return (
    <div className='wrap'>
      <div className='card'>
        <h1>Audio Chunker POC</h1>
        <div className='row'>
          <div>
            <label>Backend base URL</label>
            <input
              value={backend}
              onChange={(e) => setBackend(e.target.value)}
              placeholder='http://localhost:3000'
            />
          </div>
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
          <div>
            <label>Mime type (optional)</label>
            <input
              value={mimeType}
              onChange={(e) => setMimeType(e.target.value)}
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

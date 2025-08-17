import React, { useEffect, useRef, useState } from 'react';

type LogItem = { ts: string; msg: string };
function now() {
  return new Date().toLocaleTimeString();
}

export default function App() {
  const [backend, setBackend] = useState<string>('http://localhost:3000'); // your Nest API
  const [sessionId, setSessionId] = useState<string>(() =>
    Math.random().toString(36).slice(2)
  );
  const [timesliceMs, setTimesliceMs] = useState<number>(20000); // 60s
  const [overlapMs, setOverlapMs] = useState<number>(2000); // 2s
  const [mimeType, setMimeType] = useState<string>('audio/webm;codecs=opus');

  const [isRecording, setIsRecording] = useState(false);
  const [seq, setSeq] = useState(0);
  const [chunksSent, setChunksSent] = useState<number>(0);
  const [errors, setErrors] = useState<number>(0);
  const [log, setLog] = useState<LogItem[]>([]);
  const [therapistId, setTherapistId] = useState<string>('');
  const [patientId, setPatientId] = useState<string>('');
  const [organizationId, setOrganizationId] = useState<string>('');
  const [appointmentId, setAppointmentId] = useState<string>('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const lastTailRef = useRef<Blob | null>(null);
  const startMsRef = useRef<number>(0);
  const runningRef = useRef<boolean>(false);

  function pushLog(msg: string) {
    setLog((l) => [{ ts: now(), msg }, ...l].slice(0, 500));
  }

  function supportsMimeType(mt: string) {
    // Safari 17+ supports audio/webm;codecs=opus partially. If unsupported, let browser pick default.
    return (
      typeof MediaRecorder !== 'undefined' &&
      (MediaRecorder.isTypeSupported?.(mt) ?? true)
    );
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mt = supportsMimeType(mimeType) ? mimeType : undefined;
      const mr = new MediaRecorder(
        stream,
        mt ? ({ mimeType: mt } as MediaRecorderOptions) : undefined
      );

      mediaRecorderRef.current = mr;
      lastTailRef.current = null;
      startMsRef.current = 0;
      runningRef.current = true;
      setSeq(0);
      setChunksSent(0);
      setErrors(0);
      setIsRecording(true);
      pushLog('Recording started');

      mr.ondataavailable = async (evt: BlobEvent) => {
        if (!runningRef.current) return;
        const chunk = evt.data;
        if (!chunk || chunk.size === 0) return;

        // Approximate tail size based on timeslice ratio - good enough for a POC.
        let toUpload: Blob = chunk;

        const currentSeq = seqRef();
        const startMs = startMsRef.current;
        const endMs = startMs + timesliceMs;

        try {
          await uploadBlob(toUpload, currentSeq, startMs, endMs);
          setChunksSent((c) => c + 1);
          pushLog(`Uploaded seq=${currentSeq} bytes=${toUpload.size}`);
        } catch (e: any) {
          setErrors((x) => x + 1);
          pushLog('Upload error: ' + (e?.message || e));
        }

        // Prepare next tail from the fresh chunk
        if (overlapMs > 0) {
          const tailBytes = Math.max(
            0,
            Math.floor(chunk.size * (overlapMs / timesliceMs))
          );
          lastTailRef.current =
            tailBytes > 0
              ? chunk.slice(chunk.size - tailBytes, chunk.size)
              : null;
        }

        // Advance seq and timeline
        startMsRef.current = endMs;
        setSeq((s) => s + 1);
      };

      mr.start(timesliceMs); // trigger periodic delivery
    } catch (err: any) {
      pushLog('Mic error: ' + (err?.message || err));
    }
  }

  async function stopRecording() {
    runningRef.current = false;
    setIsRecording(false);
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    pushLog('Recording stopped');
  }

  async function finalize() {
    try {
      const res = await fetch(`${backend}/finalize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          therapistId,
          patientId,
          organizationId,
          appointmentId,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const j = await res.json();
      pushLog('Finalize: ' + JSON.stringify(j));
    } catch (e: any) {
      pushLog('Finalize error: ' + (e?.message || e));
    }
  }

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
          <div></div>
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
          <div>
            <label>Overlap (ms)</label>
            <input
              type='number'
              value={overlapMs}
              min={0}
              step={100}
              onChange={(e) => setOverlapMs(Number(e.target.value))}
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
            disabled={isRecording}
            onClick={startRecording}
          >
            Start
          </button>
          <button
            disabled={!isRecording}
            onClick={stopRecording}
          >
            Stop
          </button>
          <button onClick={finalize}>Finalize</button>
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
                The overlap is an approximation using bytes ratio - fine for a
                POC.
              </li>
              <li>The backend must expose POST /upload-chunk and /finalize.</li>
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

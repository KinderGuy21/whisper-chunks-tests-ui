export type FinalizePayload = {
  sessionId: string;
  therapistId?: string;
  patientId?: string;
  organizationId?: string;
  appointmentId?: string;
};

type UploadChunkParams = {
  chunk: Blob;
  sessionId: string;
  seq: number;
  startMs: number;
  endMs: number;
  therapistId?: string;
  patientId?: string;
  organizationId?: string;
  appointmentId?: string;
};
export async function uploadChunk(p: UploadChunkParams): Promise<void> {
  const fd = new FormData();
  fd.append('file', p.chunk, `chunk-${p.seq}.webm`);
  fd.append('mimeType', p.chunk.type);
  fd.append('sessionId', p.sessionId);
  fd.append('seq', String(p.seq));
  fd.append('startMs', String(p.startMs));
  fd.append('endMs', String(p.endMs));
  if (p.therapistId) fd.append('therapistId', p.therapistId);
  if (p.patientId) fd.append('patientId', p.patientId);
  if (p.organizationId) fd.append('organizationId', p.organizationId);
  if (p.appointmentId) fd.append('appointmentId', p.appointmentId);

  const res = await fetch('http://localhost:3000/upload-chunk', {
    method: 'POST',
    body: fd,
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function finalizeSession(payload: FinalizePayload) {
  const res = await fetch('http://localhost:3000/finalize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`Server responded with ${res.status}: ${await res.text()}`);
  }
  // Some backends return empty body on success. Try JSON, fall back to text/null.
  const text = await res.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

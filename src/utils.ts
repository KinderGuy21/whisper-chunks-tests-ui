export function now(): string {
  return new Date().toLocaleTimeString();
}

export const getSupportedMimeTypes = () => {
  if (
    typeof MediaRecorder === 'undefined' ||
    typeof MediaRecorder.isTypeSupported !== 'function'
  ) {
    console.warn('MediaRecorder is not supported');
    return [];
  }

  if (isBrowserWebkit()) {
    const supported = MediaRecorder.isTypeSupported(
      'video/mp4; codecs="avc1.42E01E, mp4a.40.2"'
    );
    if (supported) {
      return ['video/mp4; codecs="avc1.42E01E, mp4a.40.2"'];
    }
  }

  const types = ['webm', 'ogg', 'mp3', 'mp4', 'x-matroska'];
  const codecs = [
    'should-not-be-supported',
    'vp9',
    'vp9.0',
    'vp8',
    'vp8.0',
    'avc1',
    'av1',
    'h265',
    'h.265',
    'h264',
    'h.264',
    'opus',
    'pcm',
    'aac',
    'mpeg',
    'mp4a',
  ];

  const isSupported = MediaRecorder.isTypeSupported;
  const supported: string[] = [];

  types.forEach((type) => {
    const mimeType = `audio/${type}`;
    codecs.forEach((codec) => {
      [
        `${mimeType};codecs=${codec}`,
        `${mimeType};codecs=${codec.toUpperCase()}`,
      ].forEach((variation) => {
        if (isSupported(variation)) supported.push(variation);
      });
    });
    if (isSupported(mimeType)) supported.push(mimeType);
  });
  return supported;
};

export const isBrowserWebkit = () => {
  var ua = navigator.userAgent.toLowerCase();

  var isWebKit = false;

  if (
    ua.indexOf('chrome') === ua.indexOf('android') &&
    ua.indexOf('safari') !== -1
  ) {
    isWebKit = true;
  } else {
    if (
      ua.indexOf('ipad') !== -1 ||
      ua.indexOf('iphone') !== -1 ||
      ua.indexOf('ipod') !== -1
    ) {
      isWebKit = true;
    } else {
      isWebKit = false;
    }
  }

  return isWebKit;
};

import { compressSync, decompressSync, strFromU8, strToU8 } from 'fflate';

export interface SessionSignal {
  type: 'offer' | 'answer';
  sdp: string;
}

const SIGNAL_PREFIX = 'SKY1:';

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function encodeSignal(signal: SessionSignal): string {
  const compressed = compressSync(strToU8(JSON.stringify(signal)));
  return SIGNAL_PREFIX + toBase64Url(compressed);
}

export function decodeSignal(value: string): SessionSignal {
  const code = value.trim().replace(/\s+/g, '');
  if (!code.startsWith(SIGNAL_PREFIX)) throw new Error('That is not a Skyline connection code.');
  const payload = code.slice(SIGNAL_PREFIX.length);
  if (!payload || !/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error('The connection code is invalid or incomplete.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(strFromU8(decompressSync(fromBase64Url(payload))));
  } catch {
    throw new Error('The connection code is invalid or incomplete.');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    !('type' in decoded) ||
    !('sdp' in decoded) ||
    (decoded.type !== 'offer' && decoded.type !== 'answer') ||
    typeof decoded.sdp !== 'string'
  ) {
    throw new Error('The connection code is invalid or incomplete.');
  }
  return { type: decoded.type, sdp: decoded.sdp };
}

export async function waitForIceGathering(peer: RTCPeerConnection, timeoutMs = 20_000): Promise<void> {
  if (peer.iceGatheringState === 'complete') return;
  await new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      peer.removeEventListener('icegatheringstatechange', onStateChange);
      reject(new Error('Connection setup timed out while gathering local network details. Try again on the same Wi-Fi.'));
    }, timeoutMs);
    const onStateChange = () => {
      if (peer.iceGatheringState !== 'complete') return;
      window.clearTimeout(timeout);
      peer.removeEventListener('icegatheringstatechange', onStateChange);
      resolve();
    };
    peer.addEventListener('icegatheringstatechange', onStateChange);
  });
}

export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: [] });
}

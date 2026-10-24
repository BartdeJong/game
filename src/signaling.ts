import { BrowserQRCodeReader } from '@zxing/browser';
import QRCode from 'qrcode';
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
  if (!value.startsWith(SIGNAL_PREFIX)) throw new Error('That QR code is not a Skyline connection code.');
  const decoded: unknown = JSON.parse(strFromU8(decompressSync(fromBase64Url(value.slice(SIGNAL_PREFIX.length)))));
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

export function renderQr(value: string): Promise<string> {
  return QRCode.toDataURL(value, {
    errorCorrectionLevel: 'L',
    margin: 2,
    width: 420,
    color: { dark: '#14211f', light: '#ffffff' },
  });
}

export async function scanQr(video: HTMLVideoElement, signal?: AbortSignal): Promise<string> {
  if (!globalThis.isSecureContext || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    throw new Error(
      'QR scanning needs a secure HTTPS page. On iPhone, open the GitHub Pages HTTPS site; the local-network HTTP address cannot access the camera.',
    );
  }
  const reader = new BrowserQRCodeReader();
  return new Promise((resolve, reject) => {
    let controls: { stop: () => void } | undefined;
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      controls?.stop();
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new DOMException('Scan cancelled.', 'AbortError')));
    const timeout = window.setTimeout(() => {
      finish(() => reject(new Error('No QR code was scanned. Try again with the code in view.')));
    }, 90_000);

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.decodeFromVideoDevice(undefined, video, (result, error, activeControls) => {
      controls = activeControls;
      if (result && !settled) {
        finish(() => resolve(result.getText()));
      } else if (error && error.name !== 'NotFoundException' && !settled) {
        finish(() => reject(new Error(`Camera scan failed: ${error.message}`)));
      }
    }).catch((error: unknown) => {
      if (settled) return;
      finish(() => reject(error instanceof Error ? error : new Error('Camera access failed.')));
    });
  });
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

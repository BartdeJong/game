export const ROOM_CODE_LENGTH = 8;

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function createRoomCode(): string {
  const values = new Uint8Array(ROOM_CODE_LENGTH);
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new Error('Secure room-code generation is not available in this browser.');
  }
  cryptoApi.getRandomValues(values);
  return Array.from(values, (value) => ROOM_CODE_ALPHABET[value % ROOM_CODE_ALPHABET.length]).join('');
}

export function normalizeRoomCode(value: string): string {
  const code = value.toUpperCase().replace(/[\s-]/g, '');
  if (
    code.length !== ROOM_CODE_LENGTH ||
    [...code].some((character) => !ROOM_CODE_ALPHABET.includes(character))
  ) {
    throw new Error('Enter the 8-character room code shown by the host.');
  }
  return code;
}

export function formatRoomCode(code: string): string {
  return `${code.slice(0, ROOM_CODE_LENGTH / 2)}-${code.slice(ROOM_CODE_LENGTH / 2)}`;
}

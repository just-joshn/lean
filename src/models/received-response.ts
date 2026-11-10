export interface ReceivedResponse {
  readonly bytes: Uint8Array;
  readonly text: string;
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly headers?: Headers;
}

export class ResponseReadError extends Error {
  constructor(cause: unknown) {
    super("Could not read model response body", { cause });
  }
}

export function decodeResponseText(
  bytes: Uint8Array,
  headers?: Headers,
): string {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(
    headers?.get("content-type") ?? "",
  )?.[1];
  if (charset && /^(?:iso-8859-1|latin-?1)$/iu.test(charset))
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  try {
    return new TextDecoder(charset ?? "utf-8", { ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  }
}

export function responseJsonText(bytes: Uint8Array): string {
  let encoding = "utf-8";
  let offset = 0;
  let width = 1;
  let littleEndian = false;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) offset = 3;
  else if (
    bytes.length >= 4 &&
    ((bytes[0] === 0xff &&
      bytes[1] === 0xfe &&
      bytes[2] === 0 &&
      bytes[3] === 0) ||
      (bytes[0] === 0 &&
        bytes[1] === 0 &&
        bytes[2] === 0xfe &&
        bytes[3] === 0xff))
  ) {
    width = 4;
    littleEndian = bytes[0] === 0xff;
    offset = 4;
  } else if (
    (bytes[0] === 0xff && bytes[1] === 0xfe) ||
    (bytes[0] === 0xfe && bytes[1] === 0xff)
  ) {
    encoding = bytes[0] === 0xff ? "utf-16le" : "utf-16be";
    offset = 2;
  } else if (bytes.length >= 4 && (bytes[0] === 0 || bytes[1] === 0)) {
    if (
      (bytes[0] === 0 && bytes[1] === 0) ||
      (bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 0)
    ) {
      width = 4;
      littleEndian = bytes[0] !== 0;
    } else encoding = bytes[0] === 0 ? "utf-16be" : "utf-16le";
  }
  if (width === 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let result = "";
    for (let index = offset; index < bytes.length; index += 4)
      result += String.fromCodePoint(view.getUint32(index, littleEndian));
    return result;
  }
  return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(offset),
  );
}

export async function receiveResponse(
  url: string,
  init: RequestInit,
): Promise<ReceivedResponse> {
  const response = await fetch(url, init);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new ResponseReadError(error);
  }
  return {
    bytes,
    text: decodeResponseText(bytes, response.headers),
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
  };
}

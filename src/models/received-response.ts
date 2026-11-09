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
    text: new TextDecoder().decode(bytes),
    status: response.status,
    statusText: response.statusText,
    ok: response.ok,
    headers: response.headers,
  };
}

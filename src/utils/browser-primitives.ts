/**
 * Browser-safe replacements for the handful of Node primitives the SDK reaches
 * for: base64url decoding, byte-length measurement, posix path normalization,
 * and a promise-based sleep. All implementations are native (atob/TextEncoder/
 * TextDecoder/string ops) so the browser bundle ships zero polyfill weight.
 *
 * These mirror, exactly, the observable behavior of the Node equivalents they
 * replace (Buffer.from(..,"base64url"), Buffer.byteLength, path.posix.*,
 * timers/promises.setTimeout) so the same call sites work under either entry.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8");

/** UTF-8 byte length of a string. Replaces Buffer.byteLength(str). */
export function byteLength(input: string | Uint8Array): number {
  return typeof input === "string"
    ? textEncoder.encode(input).length
    : input.byteLength;
}

/** Decode a base64url (or base64) segment into bytes. */
export function base64UrlToBytes(segment: string): Uint8Array {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  // atob ignores missing padding for base64url; add it back defensively.
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Decode a base64url segment to a UTF-8 string. Replaces Buffer.from(seg,"base64url").toString("utf8"). */
export function base64UrlToString(segment: string): string {
  return textDecoder.decode(base64UrlToBytes(segment));
}

/** Sleep for `ms` milliseconds. Replaces node:timers/promises setTimeout. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

/**
 * Sleep for `ms`, rejecting early if the signal aborts. Isomorphic replacement
 * for `node:timers/promises` setTimeout(ms, value, { signal }).
 */
export function sleepWithSignal(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      globalThis.clearTimeout(timer);
      reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Inlined POSIX path operations — only the four the SDK uses (isAbsolute,
 * normalize, join, relative). Pure string algorithms, no runtime dependency.
 */
function normalizeArray(parts: string[], allowAboveRoot: boolean): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (result.length && result[result.length - 1] !== "..") {
        result.pop();
      } else if (allowAboveRoot) {
        result.push("..");
      }
    } else {
      result.push(part);
    }
  }
  return result;
}

export const posix = {
  isAbsolute(p: string): boolean {
    return p.length > 0 && p[0] === "/";
  },

  normalize(p: string): string {
    const isAbs = posix.isAbsolute(p);
    const trailingSlash = p.length > 1 && p[p.length - 1] === "/";
    let normalized = normalizeArray(p.split("/"), !isAbs).join("/");
    if (!normalized && !isAbs) normalized = ".";
    if (normalized && trailingSlash) normalized += "/";
    return (isAbs ? "/" : "") + normalized;
  },

  join(...segments: string[]): string {
    const joined = segments.filter((s) => s.length > 0).join("/");
    return joined === "" ? "." : posix.normalize(joined);
  },

  relative(from: string, to: string): string {
    from = posix.normalize(from);
    to = posix.normalize(to);
    if (from === to) return "";

    const fromParts = from.split("/").filter(Boolean);
    const toParts = to.split("/").filter(Boolean);

    let i = 0;
    const min = Math.min(fromParts.length, toParts.length);
    while (i < min && fromParts[i] === toParts[i]) i++;

    const up = fromParts.slice(i).map(() => "..");
    return [...up, ...toParts.slice(i)].join("/");
  },
};

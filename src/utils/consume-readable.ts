/**
 * Consume a stream entirely, concatenating its content into a single
 * Uint8Array. Accepts either a Node Readable (data/end events) or a WHATWG
 * ReadableStream, so the same helper works under both the Node and browser
 * builds.
 */
export async function consumeReadable(
  readable: NodeJS.ReadableStream | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (typeof (readable as ReadableStream).getReader === "function") {
    const reader = (readable as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }

  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    const node = readable as NodeJS.ReadableStream;
    node.on("error", (err) => reject(err));
    node.on("data", (chunk: Uint8Array) => chunks.push(chunk));
    node.on("end", () => {
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.byteLength;
      }
      resolve(out);
    });
  });
}

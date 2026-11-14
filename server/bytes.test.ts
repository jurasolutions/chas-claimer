import { readCapped, sha256Hex } from "./bytes";

describe("sha256Hex", () => {
  it("answers the SHA-256 of the text's UTF-8 bytes as lowercase hex", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});

describe("readCapped", () => {
  const streamed = (parts: string[]) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(utf8Bytes(p));
        c.close();
      },
    });
  const utf8Bytes = (t: string) => new TextEncoder().encode(t);

  it("reads a request or a response body up to the cap, across chunks", async () => {
    expect(await readCapped(new Response(streamed(["ab", "cd"])), 4)).toBe("abcd");
    expect(await readCapped(new Request("https://desk.example/", { method: "POST", body: "héllo" }), 6)).toBe("héllo");
    expect(await readCapped(new Response(null), 4)).toBe("");
  });

  it("answers null once the bytes pass the cap, without reading the rest", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 1;
        c.enqueue(utf8Bytes("xxxx"));
      },
    });
    expect(await readCapped(new Response(endless), 10)).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(await readCapped(new Response(streamed(["ab", "cde"])), 4)).toBeNull();
  });

  it("answers null when the declared length is over the cap, before reading", async () => {
    const res = new Response(streamed(["ab"]), { headers: { "Content-Length": "5" } });
    expect(await readCapped(res, 4)).toBeNull();
  });

  it("still counts the bytes when the declared length is under the cap but the body is not", async () => {
    const res = new Response(streamed(["x".repeat(2000)]), { headers: { "Content-Length": "10" } });
    expect(await readCapped(res, 100)).toBeNull();
  });
});

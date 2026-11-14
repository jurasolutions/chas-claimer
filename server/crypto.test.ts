import { readFileSync } from "node:fs";
import fc from "fast-check";
import { nricCheckLetter, parseNric, type Nric } from "../src/domain/nric";
import { arbSyntheticNric, arbVisitIdentity } from "../tests/helpers/arbitraries";
import { DEV_IDENTIFIER_KEY, OTHER_IDENTIFIER_KEY, TEST_IDENTIFIER_KEY, testEnv } from "../tests/helpers/env";
import { contentHash, contentHashes, currentPrefix, identifierKeys, openIdentity, patientHash, patientHashes, sealIdentity } from "./crypto";

const synthetic = (digits: string): Nric => parseNric(`T${digits}${nricCheckLetter("T", digits)}`)!;
const keysFor = async (key: string | undefined) => identifierKeys(await testEnv({ IDENTIFIER_KEY: key }));

describe("identifierKeys", () => {
  it("fails closed without a key, or with one that is not 32 bytes of base64", async () => {
    expect(await keysFor(undefined)).toBeNull();
    expect(await keysFor("")).toBeNull();
    expect(await keysFor("not base64 at all!")).toBeNull();
    expect(await keysFor(Buffer.from("only sixteen byt").toString("base64"))).toBeNull();
  });

  it("refuses the published dev key unless the request came over loopback", async () => {
    const env = await testEnv({ IDENTIFIER_KEY: DEV_IDENTIFIER_KEY });

    expect(await identifierKeys(env)).toBeNull();
    expect(await identifierKeys(env, { loopback: false })).toBeNull();
    expect(await identifierKeys(env, { loopback: true })).not.toBeNull();
    expect(await identifierKeys(await testEnv(), { loopback: false })).not.toBeNull();
  });

  it("knows the dev key package.json actually binds", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["dev:functions"]).toContain(`--binding IDENTIFIER_KEY=${DEV_IDENTIFIER_KEY} `);
  });
});

describe("patientHash", () => {
  it("is versioned, and the same for the same NRIC under the same key", async () => {
    const nric = synthetic("9000001");
    const first = await patientHash((await keysFor(TEST_IDENTIFIER_KEY))!, nric);
    const again = await patientHash((await keysFor(TEST_IDENTIFIER_KEY))!, nric);

    expect(first).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(again).toBe(first);
  });

  it("never matches across keys, so a leaked hash says nothing without the key", async () => {
    const mine = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const theirs = (await keysFor(OTHER_IDENTIFIER_KEY))!;
    await fc.assert(
      fc.asyncProperty(arbSyntheticNric, async (raw) => {
        const nric = parseNric(raw)!;
        expect(await patientHash(mine, nric)).not.toBe(await patientHash(theirs, nric));
      }),
    );
  });

  it("tells two patients apart", async () => {
    const k = (await keysFor(TEST_IDENTIFIER_KEY))!;
    expect(await patientHash(k, synthetic("9000001"))).not.toBe(await patientHash(k, synthetic("9000002")));
  });

  it("is not the content hash of the same text", async () => {
    const k = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const nric = synthetic("9000001");
    expect(await contentHash(k, nric)).not.toBe(await patientHash(k, nric));
  });
});

describe("contentHash", () => {
  it("is versioned, stable for the same text and different for different text", async () => {
    const k = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const a = await contentHash(k, '{"visitKey":"V-1"}');

    expect(a).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(await contentHash(k, '{"visitKey":"V-1"}')).toBe(a);
    expect(await contentHash(k, '{"visitKey":"V-2"}')).not.toBe(a);
  });
});

describe("sealIdentity and openIdentity", () => {
  const row = { visitKey: "V-1", revision: 1 };

  it("round-trip any identity", async () => {
    const k = (await keysFor(TEST_IDENTIFIER_KEY))!;
    await fc.assert(
      fc.asyncProperty(arbVisitIdentity, async (identity) => {
        expect(await openIdentity(k, await sealIdentity(k, identity, row), row)).toEqual(identity);
      }),
    );
  });

  it("binds the seal to its row, so a blob moved to another visit or revision is refused", async () => {
    const k = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const [identity] = fc.sample(arbVisitIdentity, { numRuns: 1, seed: 3 });
    const sealed = await sealIdentity(k, identity!, { visitKey: "V-1", revision: 2 });

    await expect(openIdentity(k, sealed, { visitKey: "V-2", revision: 2 })).rejects.toThrow();
    await expect(openIdentity(k, sealed, { visitKey: "V-1", revision: 1 })).rejects.toThrow();
    await expect(openIdentity(k, sealed, { visitKey: "V-1:2", revision: 2 })).rejects.toThrow();
    expect(await openIdentity(k, sealed, { visitKey: "V-1", revision: 2 })).toEqual(identity);
  });

  it("seals to versioned text that shows none of the identity", async () => {
    const k = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const nric = synthetic("9000003");
    const sealed = await sealIdentity(k, {
      nric,
      name: "Test Patient One",
      phone: "+65 0000 0001",
      dateOfBirth: "2091-04-05" as never,
      address: null,
      memberIds: [],
      accountHolderNric: null,
      notes: null,
      preAuthRefs: [],
    }, row);

    expect(sealed).toMatch(/^v1:[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain(nric);
    expect(sealed).not.toContain("Test Patient");
  });

  it("seals the same identity differently each time", async () => {
    const k = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const [identity] = fc.sample(arbVisitIdentity, { numRuns: 1, seed: 1 });
    expect(await sealIdentity(k, identity!, row)).not.toBe(await sealIdentity(k, identity!, row));
  });

  it("refuses to open under another key, or after any change to the sealed text", async () => {
    const k = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const other = (await keysFor(OTHER_IDENTIFIER_KEY))!;
    const [identity] = fc.sample(arbVisitIdentity, { numRuns: 1, seed: 2 });
    const sealed = await sealIdentity(k, identity!, row);
    const last = sealed.at(-2) === "A" ? "B" : "A";
    const tampered = `${sealed.slice(0, -2)}${last}${sealed.at(-1)}`;

    await expect(openIdentity(other, sealed, row)).rejects.toThrow();
    await expect(openIdentity(k, tampered, row)).rejects.toThrow();
    await expect(openIdentity(k, "v2:" + sealed.slice(3), row)).rejects.toThrow();
  });
});

describe("a key rotation (infra I1)", () => {
  const row = { visitKey: "V-1", revision: 1 };
  const nric = synthetic("9000004");
  const [identity] = fc.sample(arbVisitIdentity, { numRuns: 1, seed: 4 });
  /** The keys the desk reads mid-rotation: the new key at version 2, the old one as previous. */
  const rotating = async (extra: Record<string, string | undefined> = {}) =>
    identifierKeys(
      await testEnv({ IDENTIFIER_KEY: OTHER_IDENTIFIER_KEY, IDENTIFIER_KEY_VERSION: "2", IDENTIFIER_KEY_PREVIOUS: TEST_IDENTIFIER_KEY, ...extra }),
    );

  it("reads version 1 when no version is set, so today's v1 values still open", async () => {
    const before = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const explicit = (await identifierKeys(await testEnv({ IDENTIFIER_KEY_VERSION: "1" })))!;
    const unset = (await identifierKeys(await testEnv({ IDENTIFIER_KEY_VERSION: "" })))!;

    expect(currentPrefix(before)).toBe("v1:");
    expect(await patientHash(explicit, nric)).toBe(await patientHash(before, nric));
    expect(await openIdentity(unset, await sealIdentity(before, identity!, row), row)).toEqual(identity);
  });

  it("writes every new value with the current version's prefix", async () => {
    const k = (await rotating())!;

    expect(currentPrefix(k)).toBe("v2:");
    expect(await patientHash(k, nric)).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(await contentHash(k, "{}")).toMatch(/^v2:[0-9a-f]{64}$/);
    expect(await sealIdentity(k, identity!, row)).toMatch(/^v2:[A-Za-z0-9_-]+$/);
  });

  it("opens a value by its prefix: the previous key's while it is set, never once it is unset", async () => {
    const old = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const sealedBefore = await sealIdentity(old, identity!, row);
    const k = (await rotating())!;
    const after = (await rotating({ IDENTIFIER_KEY_PREVIOUS: undefined }))!;

    expect(await openIdentity(k, sealedBefore, row)).toEqual(identity);
    expect(await openIdentity(k, await sealIdentity(k, identity!, row), row)).toEqual(identity);
    expect(await openIdentity(after, await sealIdentity(k, identity!, row), row)).toEqual(identity);
    await expect(openIdentity(after, sealedBefore, row)).rejects.toThrow("Unknown sealed identity version.");
    await expect(openIdentity(k, "v3:" + sealedBefore.slice(3), row)).rejects.toThrow("Unknown sealed identity version.");
  });

  it("hashes under both keys while the previous key is set, current first, so earlier patients still match", async () => {
    const old = (await keysFor(TEST_IDENTIFIER_KEY))!;
    const k = (await rotating())!;
    const after = (await rotating({ IDENTIFIER_KEY_PREVIOUS: undefined }))!;

    expect(await patientHashes(k, nric)).toEqual([await patientHash(k, nric), await patientHash(old, nric)]);
    expect(await contentHashes(k, "{}")).toEqual([await contentHash(k, "{}"), await contentHash(old, "{}")]);
    expect(await patientHashes(after, nric)).toEqual([await patientHash(k, nric)]);
    expect(await patientHashes(old, nric)).toEqual([await patientHash(old, nric)]);
  });

  it("fails closed on a version that is not a whole number from 1", async () => {
    for (const version of ["0", "-1", "1.5", "two", "01", "1000"]) {
      expect(await identifierKeys(await testEnv({ IDENTIFIER_KEY_VERSION: version })), version).toBeNull();
    }
  });

  it("fails closed on a previous key that can't be right: at version 1, malformed, or the current key again", async () => {
    expect(await identifierKeys(await testEnv({ IDENTIFIER_KEY_PREVIOUS: OTHER_IDENTIFIER_KEY }))).toBeNull();
    expect(await rotating({ IDENTIFIER_KEY_PREVIOUS: "not base64 at all!" })).toBeNull();
    expect(await rotating({ IDENTIFIER_KEY_PREVIOUS: Buffer.from("only sixteen byt").toString("base64") })).toBeNull();
    expect(await rotating({ IDENTIFIER_KEY_PREVIOUS: OTHER_IDENTIFIER_KEY })).toBeNull();
    expect(await rotating({ IDENTIFIER_KEY_PREVIOUS: "" })).not.toBeNull();
  });

  it("refuses the published dev key as either key unless the request came over loopback", async () => {
    const asPrevious = await testEnv({ IDENTIFIER_KEY: OTHER_IDENTIFIER_KEY, IDENTIFIER_KEY_VERSION: "2", IDENTIFIER_KEY_PREVIOUS: DEV_IDENTIFIER_KEY });
    const asCurrent = await testEnv({ IDENTIFIER_KEY: DEV_IDENTIFIER_KEY, IDENTIFIER_KEY_VERSION: "2", IDENTIFIER_KEY_PREVIOUS: TEST_IDENTIFIER_KEY });

    expect(await identifierKeys(asPrevious)).toBeNull();
    expect(await identifierKeys(asCurrent)).toBeNull();
    expect(await identifierKeys(asPrevious, { loopback: true })).not.toBeNull();
    expect(await identifierKeys(asCurrent, { loopback: true })).not.toBeNull();
  });
});

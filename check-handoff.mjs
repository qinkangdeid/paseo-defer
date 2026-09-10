/**
 * Guards the hand-over of a session's composer draft into the Defer box.
 *
 * Two things here are invisible to typecheck and expensive to get wrong. The
 * first is the read: the draft store belongs to the app, not to this plugin, so
 * every assumption about its shape is asserted against the record the app
 * actually writes — including the one it leaves behind after a send, which
 * keeps the key with an empty string and a settled lifecycle. Taking that would
 * hand a message back to a session that has already had it.
 *
 * The second is the offer itself. The press that reads the draft happens before
 * the panel exists, so an offer has to survive until a view subscribes, be
 * handed over exactly once, and expire rather than turn up in a box opened
 * minutes later for something else.
 */
import * as esbuild from "esbuild";
import { rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { instantiateBundle } from "./check-lib.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ENTRY = resolve(DIR, ".check-handoff.entry.ts");
const ENTRY_SOURCE = `export {
  offerComposerDraft,
  offerDefer,
  onComposerDraftOffered,
  readComposerDraft,
  readDraftText,
} from "./client/handoff";
export { clientBridge } from "./shared/bridge";
`;

const failures = [];
function check(condition, description) {
  if (condition) return;
  failures.push(description);
}

/** The envelope the app writes, as observed in a real installation. */
function store(drafts) {
  return JSON.stringify({ state: { drafts, createModalDraft: null }, version: 5 });
}

function record(text, { lifecycle = "active", updatedAt = 1 } = {}) {
  return { input: { text, attachments: [] }, lifecycle, updatedAt, version: 20 };
}

async function load() {
  writeFileSync(ENTRY, ENTRY_SOURCE);
  try {
    const built = await esbuild.build({
      entryPoints: [ENTRY],
      bundle: true,
      write: false,
      format: "cjs",
      platform: "neutral",
      target: "es2020",
      absWorkingDir: DIR,
      logLevel: "silent",
    });
    return built.outputFiles[0].text;
  } finally {
    rmSync(ENTRY, { force: true });
  }
}

const CODE = await load();
const fresh = () =>
  instantiateBundle(CODE, (id) => {
    throw new Error(`Module "${id}" is not available in plugin client code`);
  });

const AGENT = "d5f57b6c-e96b-4ecd-96fc-d6779a7c7234";
const KEY = `agent:srv_KUQ4uZvm6nCK:${AGENT}`;

try {
  const { readDraftText, readComposerDraft, offerComposerDraft, offerDefer, onComposerDraftOffered, clientBridge } =
    fresh();

  // --- Reading the app's own draft store ---
  check(
    readDraftText(store({ [KEY]: record("Go over the doc ") }), AGENT) === "Go over the doc ",
    "a session's own draft is read back verbatim, trailing space and all",
  );
  check(
    readDraftText(store({ [`agent:srv_x:other-agent`]: record("not mine") }), AGENT) === "",
    "another session's draft is never taken",
  );
  check(
    readDraftText(store({ [KEY]: record("", { lifecycle: "sent" }) }), AGENT) === "",
    "a draft cleared by sending offers nothing",
  );
  check(
    readDraftText(store({ [KEY]: record("still here", { lifecycle: "abandoned" }) }), AGENT) === "",
    "only an active draft is offered",
  );
  check(
    readDraftText(store({ [KEY]: record("   ") }), AGENT) === "",
    "a box holding only whitespace is nothing to hand over",
  );
  check(
    readDraftText(
      store({
        [`draft:srv_KUQ4uZvm6nCK:draft_${AGENT}`]: record("new workspace draft"),
      }),
      AGENT,
    ) === "",
    "a new-workspace draft is not mistaken for a session's",
  );
  check(
    readDraftText(
      store({
        [`agent:srv_a:${AGENT}`]: record("older", { updatedAt: 10 }),
        [`agent:srv_b:${AGENT}`]: record("newer", { updatedAt: 20 }),
      }),
      AGENT,
    ) === "newer",
    "with more than one record for a session, the freshest wins",
  );
  check(
    readDraftText(
      store({ [KEY]: { text: "flat legacy", lifecycle: "active", updatedAt: 1, version: 1 } }),
      AGENT,
    ) === "flat legacy",
    "the app's older flat record shape is still readable",
  );

  // Anything unexpected reads as "no draft", never as a failure.
  for (const [raw, description] of [
    [null, "a host with no draft store"],
    ["", "an empty value"],
    ["{oh no", "a value that is not JSON"],
    ["[]", "a value that is not the store"],
    [JSON.stringify({ state: { drafts: null } }), "a store with no drafts"],
    [store({ [KEY]: null }), "a record that is not an object"],
    [store({ [KEY]: { input: { text: 42 }, lifecycle: "active" } }), "text that is not a string"],
  ]) {
    check(readDraftText(raw, AGENT) === "", `${description} offers nothing`);
  }
  check(readDraftText(store({ [KEY]: record("mine") }), "") === "", "no session means no draft");

  // --- Reaching whatever storage the host has ---
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const setStorage = (value) => {
    if (value === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", { value, configurable: true });
  };
  try {
    setStorage(undefined);
    check(readComposerDraft(AGENT) === "", "a host without web storage hands over nothing");
    setStorage({
      getItem() {
        throw new Error("blocked");
      },
    });
    check(readComposerDraft(AGENT) === "", "storage that refuses access is not an error");
    setStorage({ getItem: (key) => (key === "paseo-drafts" ? store({ [KEY]: record("hi") }) : null) });
    check(readComposerDraft(AGENT) === "hi", "the draft is read from the app's own key");

    // --- Offering it to a view that is still opening ---
    const seen = [];
    offerComposerDraft(AGENT);
    const stop = onComposerDraftOffered(AGENT, (offer) => seen.push(offer.text));
    check(seen.join("|") === "hi", "an offer waits for the view the press is opening");

    const late = [];
    onComposerDraftOffered(AGENT, (offer) => late.push(offer.text));
    check(late.length === 0, "a hand-over happens once, not to every view that opens later");

    // With a view already mounted the offer goes straight to it.
    setStorage({ getItem: () => store({ [KEY]: record("second") }) });
    offerComposerDraft(AGENT);
    check(seen.join("|") === "hi|second", "a mounted view is handed the draft directly");
    check(late.join("|") === "second", "every view of that session is handed it");

    const others = [];
    onComposerDraftOffered("someone-else", (offer) => others.push(offer.text));
    setStorage({ getItem: () => store({ [KEY]: record("third") }) });
    offerComposerDraft(AGENT);
    check(others.length === 0, "an offer only reaches the session it was read from");

    stop();
    stop();
    const before = seen.length;
    offerComposerDraft(AGENT);
    check(seen.length === before, "a view that has gone is no longer handed anything");

    // An empty composer must not clear a box someone is already using.
    setStorage({ getItem: () => store({ [KEY]: record("") }) });
    const quiet = [];
    const stopQuiet = onComposerDraftOffered(AGENT, (offer) => quiet.push(offer.text));
    offerComposerDraft(AGENT);
    check(quiet.length === 0, "an empty prompt box hands over nothing at all");
    stopQuiet();

    // A stale offer must expire rather than surface in a later panel.
    const now = Date.now;
    try {
      setStorage({ getItem: () => store({ [KEY]: record("ancient") }) });
      offerComposerDraft(AGENT);
      Date.now = () => now() + 60_000;
      const stale = [];
      onComposerDraftOffered(AGENT, (offer) => stale.push(offer.text));
      check(stale.length === 0, "an offer nobody collected expires instead of waiting forever");
    } finally {
      Date.now = now;
    }

    // A hand-over can carry the timing as well: this is how a `/defer` line
    // that named a time but could not be queued reaches the panel.
    const carried = [];
    const stopCarried = onComposerDraftOffered(AGENT, (offer) => carried.push(offer));
    offerDefer(AGENT, { text: "ship it", trigger: { kind: "after", ms: 7_200_000 } });
    check(
      carried[0]?.text === "ship it" && carried[0]?.trigger?.ms === 7_200_000,
      "an offer carries the timing it was written with",
    );
    offerDefer(AGENT, { text: "", trigger: { kind: "sessionReset" } });
    check(
      carried[1]?.trigger?.kind === "sessionReset" && carried[1]?.text === "",
      "a timing with no message is still worth handing over",
    );
    offerDefer(AGENT, { text: "   ", trigger: null });
    check(carried.length === 2, "an offer with neither text nor timing is not made at all");
    stopCarried();

    check(clientBridge.offer === offerDefer, "the shared body can reach the hand-over");

    // One broken view must not cost the others their text.
    setStorage({ getItem: () => store({ [KEY]: record("shared") }) });
    const survivors = [];
    onComposerDraftOffered(AGENT, () => {
      throw new Error("this view is broken");
    });
    onComposerDraftOffered(AGENT, (offer) => survivors.push(offer.text));
    offerComposerDraft(AGENT);
    check(survivors.join("|") === "shared", "a view that throws does not swallow the hand-over");
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, "localStorage", original);
  }
} catch (error) {
  failures.push(error instanceof Error ? (error.stack ?? error.message) : String(error));
}

for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error("Composer hand-over check failed.");
  process.exit(1);
}
console.log("  ✓ handoff: the composer draft is read safely and handed over exactly once");
process.exit(0);

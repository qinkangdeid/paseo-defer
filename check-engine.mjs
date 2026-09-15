/**
 * Exercises the scheduler's due-selection against a fake daemon and store.
 *
 * This is the code that decides a message is ready to land in someone's real
 * conversation, and its hardest case has no type and no UI: the provider's
 * usage-window reset is re-derived on every upstream read, so the same rollover
 * comes back with a different fraction of a second each time. Comparing those
 * exactly once made every `sessionReset` message fire on the next refresh,
 * hours early. The instants below are the ones actually recorded when that
 * happened.
 *
 * `server/engine.ts` starts its tick as an import side effect and talks to the
 * daemon, so the two server modules and the lifecycle bridge are replaced with
 * stubs at bundle time and driven from `globalThis`.
 */
import * as esbuild from "esbuild";
import { instantiateBundle } from "./check-lib.mjs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as crypto from "node:crypto";
import * as zod from "zod";

const DIR = dirname(fileURLToPath(import.meta.url));

/** What the stubbed store and daemon answer with, and what the store recorded. */
const world = {
  items: [],
  resetsAt: null,
  resetsByProvider: new Map(),
  providers: new Map([["agent", "provider-a"]]),
  providerLookups: [],
  usageLookups: [],
  usageFails: false,
  updates: [],
  lifecycle: { teardown: null },
};
globalThis.__deferCheck = world;

const STUBS = {
  "./store": `
    export const store = {
      list: async () => globalThis.__deferCheck.items,
      update: async (id, patch) => {
        globalThis.__deferCheck.updates.push({ id, patch });
        return null;
      },
      recoverInterrupted: async () => 0,
    };
  `,
  "./daemon": `
    export const fetchSessionResetsAt = async (provider) => {
      if (globalThis.__deferCheck.usageFails) throw new Error("usage unavailable");
      globalThis.__deferCheck.usageLookups.push(provider);
      return globalThis.__deferCheck.resetsByProvider.get(provider) ?? globalThis.__deferCheck.resetsAt;
    };
    export const getProviderByAgentId = async (agentId) => {
      globalThis.__deferCheck.providerLookups.push(agentId);
      return globalThis.__deferCheck.providers.get(agentId) ?? null;
    };
    export const readAgentStates = async () => new Map();
    export const withDaemon = async (work) => work({});
    export const clearCaches = () => {};
  `,
  "../shared/lifecycle": `export const lifecycle = globalThis.__deferCheck.lifecycle;`,
};

const stubPlugin = {
  name: "defer-check-stubs",
  setup(build) {
    build.onResolve({ filter: /^(\.\/(store|daemon)|\.\.\/shared\/lifecycle)$/ }, (args) => ({
      path: args.path,
      namespace: "defer-stub",
    }));
    build.onLoad({ filter: /.*/, namespace: "defer-stub" }, (args) => ({
      contents: STUBS[args.path],
      loader: "js",
    }));
  },
};

async function loadEngine() {
  const built = await esbuild.build({
    entryPoints: [resolve(DIR, "server/engine.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    external: ["zod", "@getpaseo/plugin", "node:crypto"],
    plugins: [stubPlugin],
    absWorkingDir: DIR,
    logLevel: "silent",
  });
  return instantiateBundle(built.outputFiles[0].text, (id) => {
    if (id === "node:crypto") return crypto;
    if (id === "zod") return {};
    if (id === "@getpaseo/plugin") return { defineRpc: (d) => d };
    throw new Error(`Module "${id}" is not available here`);
  });
}

async function loadServerContribution() {
  const stubs = {
    "./server/daemon": `
      export const fetchSessionResetsAt = async () => null;
      export const fetchSessions = async () => [];
      export const getProviderByAgentId = async (agentId) => {
        globalThis.__deferCheck.providerLookups.push(agentId);
        return globalThis.__deferCheck.providers.get(agentId) ?? null;
      };
    `,
    "./server/engine": `
      export const createDeferredRecord = (input) => input;
      export const resolveDueAt = async (_trigger, _createdAt, provider) => {
        globalThis.__deferCheck.resolvedProviders.push(provider);
        return { dueAt: "2026-09-02T20:50:00.000Z", anchorResetsAt: "2026-09-02T20:50:00.000Z" };
      };
    `,
    "./server/settings": `
      export const settings = {
        read: async () => ({ pillMode: "always" }),
        write: async () => ({ pillMode: "always" }),
      };
    `,
    "./server/store": `
      export const store = {
        list: async () => globalThis.__deferCheck.serverItems,
        add: async (item) => item,
        update: async () => null,
        updatePending: async (id, patch) => {
          const item = globalThis.__deferCheck.serverItems.find((candidate) => candidate.id === id);
          return item === undefined
            ? { item: null, reason: "missing" }
            : { item: { ...item, ...patch }, reason: null };
        },
        removeSettled: async () => 0,
      };
    `,
    "./shared/lifecycle": `export const lifecycle = { teardown: null };`,
  };
  const plugin = {
    name: "defer-server-stubs",
    setup(build) {
      build.onResolve({ filter: /^\.\/(server\/(daemon|engine|settings|store)|shared\/lifecycle)$/ }, (args) => ({
        path: args.path,
        namespace: "defer-server-stub",
      }));
      build.onLoad({ filter: /.*/, namespace: "defer-server-stub" }, (args) => ({
        contents: stubs[args.path],
        loader: "js",
      }));
    },
  };
  const built = await esbuild.build({
    entryPoints: [resolve(DIR, "index.server.ts")],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "neutral",
    target: "es2020",
    external: ["zod", "@getpaseo/plugin"],
    plugins: [plugin],
    absWorkingDir: DIR,
    logLevel: "silent",
  });
  return instantiateBundle(built.outputFiles[0].text, (id) => {
    if (id === "zod") return zod;
    if (id === "@getpaseo/plugin") return { defineRpc: (definition) => definition };
    throw new Error(`Module "${id}" is not available here`);
  });
}

const failures = [];
function check(condition, description) {
  if (condition) return;
  failures.push(description);
}

/** A queued `sessionReset` message anchored to `anchor`. */
function reset(anchor, id = "r1", agentId = "agent") {
  return {
    id,
    agentId,
    text: "x",
    trigger: { kind: "sessionReset" },
    dueAt: anchor,
    anchorResetsAt: anchor,
    createdAt: "2026-09-02T14:02:06.848Z",
    state: "pending",
    settledAt: null,
    error: null,
  };
}

function timed(dueAt, id = "t1") {
  return {
    id,
    agentId: "agent",
    text: "x",
    trigger: { kind: "after", ms: 900_000 },
    dueAt,
    anchorResetsAt: null,
    createdAt: "2026-09-02T14:02:06.848Z",
    state: "pending",
    settledAt: null,
    error: null,
  };
}

const at = (iso) => Date.parse(iso);

// The three values one 15:50 rollover reported on three consecutive reads.
const READS = [
  "2026-09-02T15:49:59.982463+00:00",
  "2026-09-02T15:50:00.077483+00:00",
  "2026-09-02T15:50:00.309167+00:00",
];
const BEFORE = at("2026-09-02T14:03:59.000Z");

try {
  const engine = await loadEngine();
  const { isResetDue, selectDue, resolveDueAt } = engine;

  // The regression. Every pairing of two reads of the same window, an hour and
  // three quarters before it ends, must stay put.
  for (const anchor of READS) {
    for (const current of READS) {
      check(
        isResetDue(reset(anchor), current, BEFORE) === false,
        `a re-read of the same window is not a rollover (anchor ${anchor}, read ${current})`,
      );
    }
  }

  // What must still fire.
  check(
    isResetDue(reset(READS[0]), READS[0], at("2026-09-02T15:50:00.000Z")) === true,
    "the anchor being reached fires it",
  );
  check(
    isResetDue(reset(READS[0]), null, at("2026-09-02T15:49:58.000Z")) === false,
    "a second before the anchor it is not due",
  );
  check(
    isResetDue(reset(READS[0]), "2026-09-02T20:50:00.000Z", BEFORE) === true,
    "a window that now ends five hours later is a rollover we were slow to notice",
  );

  // Where the line sits between the two.
  const anchorMs = at(READS[0]);
  const shifted = (ms) => new Date(anchorMs + ms).toISOString();
  check(isResetDue(reset(READS[0]), shifted(59_000), BEFORE) === false, "59s of drift is the same window");
  check(isResetDue(reset(READS[0]), shifted(61_000), BEFORE) === true, "61s later is a different window");

  // Degenerate anchors must never fire rather than fire at once.
  check(isResetDue({ ...reset(READS[0]), anchorResetsAt: null }, READS[0], BEFORE) === false,
    "an item with no anchor yet is not due");
  check(isResetDue({ ...reset(READS[0]), anchorResetsAt: "not a date" }, READS[0], BEFORE) === false,
    "an unreadable anchor is not due");
  check(isResetDue({ ...reset(READS[0]), anchorResetsAt: READS[0] }, "not a date", BEFORE) === false,
    "an unreadable current read is not a rollover");

  // Now the same thing through selectDue, which is what the tick calls.
  world.resetsAt = READS[2];
  world.resetsByProvider = new Map();
  world.updates = [];
  world.providerLookups = [];
  world.usageLookups = [];
  let due = await selectDue([reset(READS[0], "a"), reset(READS[1], "b"), reset(READS[2], "c")], BEFORE);
  check(due.length === 0, "three messages queued against one window all wait");
  check(world.updates.length === 0, "and none of them is rewritten while it waits");
  check(
    world.providerLookups.length === 3 && world.providerLookups.every((agentId) => agentId === "agent"),
    "each reset reads its item's session provider",
  );
  check(
    world.usageLookups.length === 3 && world.usageLookups.every((provider) => provider === "provider-a"),
    "each reset reads the provider returned for its session",
  );

  // Two providers in one tick must each be compared with their own window.
  world.providers = new Map([
    ["agent-a", "provider-a"],
    ["agent-b", "provider-b"],
  ]);
  world.resetsByProvider = new Map([
    ["provider-a", READS[2]],
    ["provider-b", "2026-09-02T20:50:00.000Z"],
  ]);
  world.providerLookups = [];
  world.usageLookups = [];
  due = await selectDue(
    [reset(READS[0], "a", "agent-a"), reset(READS[0], "b", "agent-b")],
    BEFORE,
  );
  check(due.length === 1 && due[0].id === "b", "each provider's reset is evaluated independently");
  check(
    world.usageLookups.join(",") === "provider-a,provider-b",
    "a mixed-provider tick reads both provider windows",
  );
  world.providers = new Map([["agent", "provider-a"]]);
  world.resetsByProvider = new Map();

  world.updates = [];
  due = await selectDue([reset(READS[0], "a"), timed("2026-09-02T14:03:00.000Z", "t")], BEFORE);
  check(due.length === 1 && due[0].id === "t", "a timed message due now is still delivered alongside");

  due = await selectDue([reset(READS[0], "a")], at("2026-09-02T15:50:01.000Z"));
  check(due.length === 1 && due[0].id === "a", "past the window end it goes out");

  // An item queued while the window was unreadable adopts the first one it sees.
  world.updates = [];
  due = await selectDue([{ ...reset(READS[0], "a"), anchorResetsAt: null, dueAt: null }], BEFORE);
  check(due.length === 0, "an unanchored item does not fire on the read that anchors it");
  check(
    world.updates.length === 1 &&
      world.updates[0].patch.anchorResetsAt === READS[2] &&
      world.updates[0].patch.dueAt === READS[2],
    "it adopts the window it just read, as both anchor and due date",
  );

  // A window end revised earlier is followed, not fired on.
  world.resetsAt = "2026-09-02T15:20:00.000Z";
  world.updates = [];
  due = await selectDue([reset(READS[0], "a")], BEFORE);
  check(due.length === 0, "a window that now ends earlier does not fire");
  check(
    world.updates.length === 1 && world.updates[0].patch.dueAt === "2026-09-02T15:20:00.000Z",
    "it re-anchors to the earlier end instead",
  );

  // A daemon that cannot answer must hold reset triggers, not release them.
  world.usageFails = true;
  world.updates = [];
  due = await selectDue([reset(READS[0], "a"), timed("2026-09-02T14:03:00.000Z", "t")], BEFORE);
  check(due.length === 1 && due[0].id === "t", "an unreadable usage window holds reset triggers back");
  world.usageFails = false;

  // Timed triggers are resolved up front and carry no anchor.
  const after = await resolveDueAt({ kind: "after", ms: 180_000 }, "2026-09-02T14:00:00.000Z", null);
  check(after.dueAt === "2026-09-02T14:03:00.000Z" && after.anchorResetsAt === null,
    "an `after` trigger resolves to createdAt plus the wait");
  world.resetsAt = READS[2];
  const onReset = await resolveDueAt(
    { kind: "sessionReset" },
    "2026-09-02T14:00:00.000Z",
    "provider-a",
  );
  check(onReset.dueAt === READS[2] && onReset.anchorResetsAt === READS[2],
    "a `sessionReset` trigger records the window it was queued against");
  world.usageLookups = [];
  const unknownProvider = await resolveDueAt(
    { kind: "sessionReset" },
    "2026-09-02T14:00:00.000Z",
    null,
  );
  check(
    unknownProvider.dueAt === null && unknownProvider.anchorResetsAt === null,
    "an unknown provider stays unanchored rather than borrowing another provider's window",
  );
  check(world.usageLookups.length === 0, "an unknown provider performs no usage lookup");

  // The update RPC must resolve a reset from the queued row, never a client
  // supplied or currently selected session.
  const serverGraph = await loadServerContribution();
  const handlers = new Map();
  serverGraph.default({ handle: (contract, handler) => handlers.set(contract.name, handler) });
  world.serverItems = [reset(READS[0], "stored", "agent-b")];
  world.providers = new Map([
    ["agent-a", "provider-a"],
    ["agent-b", "provider-b"],
  ]);
  world.providerLookups = [];
  world.resolvedProviders = [];
  const update = handlers.get("defer.update");
  await update({
    id: "stored",
    text: "edited",
    trigger: { kind: "sessionReset" },
    agentId: "agent-a",
  });
  check(
    world.providerLookups.join(",") === "agent-b" && world.resolvedProviders.join(",") === "provider-b",
    "editing resolves the provider from the stored target rather than client state",
  );

  await world.lifecycle.teardown?.();
} catch (error) {
  failures.push(`the engine check could not run: ${error?.stack ?? error}`);
}

console.log("Checking the Defer scheduler...");
for (const failure of failures) console.error(`  ✗ ${failure}`);
if (failures.length > 0) {
  console.error(`${failures.length} scheduler check(s) failed`);
  process.exit(1);
}
console.log("  ✓ sessionReset fires on the rollover, not on a re-read of the same window");
console.log("  ✓ provider-specific resets, edits and missing-provider behavior are isolated");
console.log("  ✓ timed triggers, first-window adoption and an unreadable daemon all behave");

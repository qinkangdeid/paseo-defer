import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelDeferred,
  clearSettled,
  createDeferred,
  listDeferred,
  listSessions,
  updateDeferred,
  updateSettings,
  type Deferred,
} from "./shared/defer";
import { fetchSessionResetsAt, fetchSessions, getProviderByAgentId } from "./server/daemon";
import { createDeferredRecord, resolveDueAt } from "./server/engine";
import { settings } from "./server/settings";
import { store } from "./server/store";
import { lifecycle } from "./shared/lifecycle";

export default function contribute(server: PluginServerContext) {
  server.handle(listDeferred, async ({ agentId, usageAgentId }) => {
    const all = await store.list();
    const items = agentId === undefined ? all : all.filter((item) => item.agentId === agentId);
    let sessionResetsAt: string | null = null;
    let usageError: string | null = null;
    try {
      const providerAgentId = usageAgentId ?? agentId;
      const provider = await getProviderByAgentId(providerAgentId);
      sessionResetsAt = provider === null ? null : await fetchSessionResetsAt(provider);
    } catch (error) {
      usageError = error instanceof Error ? error.message : String(error);
    }
    items.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return { items, sessionResetsAt, usageError, settings: await settings.read() };
  });

  server.handle(updateSettings, async (patch) => ({ settings: await settings.write(patch) }));
  server.handle(listSessions, async () => ({ sessions: await fetchSessions() }));

  server.handle(createDeferred, async ({ agentId, text, trigger }) => {
    const createdAt = new Date().toISOString();
    const provider = trigger.kind === "sessionReset" ? await getProviderByAgentId(agentId) : null;
    const { dueAt, anchorResetsAt } = await resolveDueAt(trigger, createdAt, provider);
    const item = await store.add(
      createDeferredRecord({ agentId, text, trigger, dueAt, anchorResetsAt }),
    );
    console.log(`[defer] queued ${item.id} for ${agentId} (${trigger.kind})`);
    return { item };
  });

  server.handle(updateDeferred, async ({ id, text, trigger }) => {
    const patch: Partial<Deferred> = {};
    if (text !== undefined) patch.text = text;
    if (trigger !== undefined) {
      const editedAt = new Date().toISOString();
      let provider: string | null = null;
      if (trigger.kind === "sessionReset") {
        const existing = (await store.list()).find((item) => item.id === id);
        if (existing === undefined) {
          return { item: null, error: "That message is no longer queued." };
        }
        if (existing.state !== "pending") {
          return { item: null, error: "That message is already on its way; it can no longer be edited." };
        }
        provider = await getProviderByAgentId(existing.agentId);
      }
      const { dueAt, anchorResetsAt } = await resolveDueAt(trigger, editedAt, provider);
      patch.trigger = trigger;
      patch.dueAt = dueAt;
      patch.anchorResetsAt = anchorResetsAt;
    }
    const { item, reason } = await store.updatePending(id, patch);
    if (reason === "missing") return { item: null, error: "That message is no longer queued." };
    if (reason === "settled") {
      return { item: null, error: "That message is already on its way; it can no longer be edited." };
    }
    console.log(`[defer] edited ${id}`);
    return { item, error: null };
  });

  server.handle(cancelDeferred, async ({ id }) => {
    const updated = await store.update(id, {
      state: "cancelled",
      settledAt: new Date().toISOString(),
    });
    return { ok: updated !== null };
  });

  server.handle(clearSettled, async ({ agentId }) => ({
    removed: await store.removeSettled(agentId),
  }));

  return async () => {
    const teardown = lifecycle.teardown;
    lifecycle.teardown = null;
    await teardown?.();
  };
}

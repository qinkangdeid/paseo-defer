import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  cancelDeferred,
  clearSettled,
  createDeferred,
  listDeferred,
  listSessions,
  updateDeferred,
  updateSettings,
} from "./shared/defer";
import { fetchSessionResetsAt, fetchSessions, getProviderByAgentId } from "./server/daemon";
import { createDeferredItem, updateDeferredItem } from "./server/queue";
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

  server.handle(createDeferred, createDeferredItem);
  server.handle(updateDeferred, updateDeferredItem);

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

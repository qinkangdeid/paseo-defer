import type { Deferred, Trigger } from "../shared/defer";
import { getProviderByAgentId } from "./daemon";
import { createDeferredRecord, resolveDueAt } from "./engine";
import { store } from "./store";

export async function createDeferredItem(input: {
  agentId: string;
  text: string;
  trigger: Trigger;
}): Promise<{ item: Deferred }> {
  const createdAt = new Date().toISOString();
  const provider =
    input.trigger.kind === "sessionReset" ? await getProviderByAgentId(input.agentId) : null;
  if (input.trigger.kind === "sessionReset" && provider === null) {
    throw new Error("The target session is gone.");
  }
  const { dueAt, anchorResetsAt } = await resolveDueAt(input.trigger, createdAt, provider);
  const item = await store.add(
    createDeferredRecord({
      agentId: input.agentId,
      text: input.text,
      trigger: input.trigger,
      dueAt,
      anchorResetsAt,
    }),
  );
  console.log(`[defer] queued ${item.id} for ${input.agentId} (${input.trigger.kind})`);
  return { item };
}

export async function updateDeferredItem(input: {
  id: string;
  text?: string | undefined;
  trigger?: Trigger | undefined;
}): Promise<{ item: Deferred | null; error: string | null }> {
  const patch: Partial<Deferred> = {};
  if (input.text !== undefined) patch.text = input.text;
  if (input.trigger !== undefined) {
    const editedAt = new Date().toISOString();
    let provider: string | null = null;
    if (input.trigger.kind === "sessionReset") {
      const existing = (await store.list()).find((item) => item.id === input.id);
      if (existing === undefined) {
        return { item: null, error: "That message is no longer queued." };
      }
      if (existing.state !== "pending") {
        return {
          item: null,
          error: "That message is already on its way; it can no longer be edited.",
        };
      }
      provider = await getProviderByAgentId(existing.agentId);
      if (provider === null) {
        return { item: null, error: "The target session is gone; its timing was not changed." };
      }
    }
    const resolved = await resolveDueAt(input.trigger, editedAt, provider);
    patch.trigger = input.trigger;
    patch.dueAt = resolved.dueAt;
    patch.anchorResetsAt = resolved.anchorResetsAt;
  }
  const { item, reason } = await store.updatePending(input.id, patch);
  if (reason === "missing") return { item: null, error: "That message is no longer queued." };
  if (reason === "settled") {
    return {
      item: null,
      error: "That message is already on its way; it can no longer be edited.",
    };
  }
  console.log(`[defer] edited ${input.id}`);
  return { item, error: null };
}

import type { Trigger } from "./defer";

/**
 * Small client-only handoff slots shared by independently registered views.
 * The file lives in `shared/` because it contains no platform APIs; only the
 * v0.8 client entrypoint imports the client modules that populate these slots.
 */
export interface DeferOffer {
  /** Prefills the message box. */
  text: string;
  /** Preselects the timing controls; null leaves whatever they were showing. */
  trigger: Trigger | null;
}

export interface ClientBridge {
  /** Hands text and timing to the next Defer view opened for that session. */
  offer: ((agentId: string, offer: DeferOffer) => void) | null;
  /** Tells the views and the composer pill that the queue has changed. */
  changed: (() => void) | null;
}

export const clientBridge: ClientBridge = { offer: null, changed: null };

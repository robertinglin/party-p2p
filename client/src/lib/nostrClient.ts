import type { Event, Filter } from "nostr-tools";
import { relayPeerIdFromAddress } from "./relayBook";

export type NostrProtocolMessage =
  | ["EVENT", Event]
  | ["EVENT", string, Event]
  | ["REQ", string, ...Filter[]]
  | ["CLOSE", string]
  | ["EOSE", string]
  | ["OK", string, boolean, string]
  | ["NOTICE", string];

export type NostrSubscription = {
  close: () => void;
};

export type DataConnectionLike = {
  open: boolean;
  peer: string;
  send: (data: unknown) => void;
  close: () => void;
  on: (event: string, callback: (...args: any[]) => void) => void;
};

export type PeerLike = {
  id?: string;
  connect: (peerId: string, options?: Record<string, unknown>) => DataConnectionLike;
};

export type RelayQueryResult = {
  address: string;
  live: boolean;
  events: Event[];
};

export type RelaySetQueryResult = {
  events: Event[];
  liveRelays: string[];
  offlineRelays: string[];
};

export type RelayStatus = {
  address: string;
  live: boolean;
  relayAddress?: string;
  roomPeerId?: string;
  relayMeshPeerId?: string;
  relayHints?: string[];
  icedRelayHints?: string[];
  load?: {
    clients?: number;
    roomHosts?: number;
    relayConnections?: number;
    knownRelays?: number;
  };
};

export function isNostrProtocolMessage(value: unknown): value is NostrProtocolMessage {
  return Array.isArray(value) && typeof value[0] === "string" && ["EVENT", "REQ", "CLOSE", "EOSE", "OK", "NOTICE"].includes(value[0]);
}

function waitForOpen(conn: DataConnectionLike, timeoutMs: number): Promise<boolean> {
  if (conn.open) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (open: boolean) => {
      if (settled) return;
      settled = true;
      resolve(open);
    };
    conn.on("open", () => finish(true));
    conn.on("close", () => finish(false));
    conn.on("error", () => finish(false));
    globalThis.setTimeout(() => finish(false), timeoutMs);
  });
}

function uniqueEvents(events: Event[]): Event[] {
  const byId = new Map<string, Event>();
  for (const event of events) byId.set(event.id, event);
  return Array.from(byId.values()).sort((left, right) => left.created_at - right.created_at || left.id.localeCompare(right.id));
}

export class RoomNostrClient {
  private nextSubscriptionId = 1;
  private readonly subscriptions = new Map<string, (event: Event) => void>();
  private readonly eoseHandlers = new Map<string, () => void>();

  constructor(private readonly send: (message: NostrProtocolMessage) => void) {}

  publish(event: Event): void {
    this.send(["EVENT", event]);
  }

  subscribe(filter: Filter, onEvent: (event: Event) => void): NostrSubscription {
    const subscriptionId = `sub_${this.nextSubscriptionId++}`;
    this.subscriptions.set(subscriptionId, onEvent);
    this.send(["REQ", subscriptionId, filter]);
    return {
      close: () => {
        this.subscriptions.delete(subscriptionId);
        this.eoseHandlers.delete(subscriptionId);
        this.send(["CLOSE", subscriptionId]);
      }
    };
  }

  query(filter: Filter, timeoutMs = 1500): Promise<Event[]> {
    const events: Event[] = [];
    const subscriptionId = `sub_${this.nextSubscriptionId++}`;
    this.subscriptions.set(subscriptionId, (event) => events.push(event));
    this.send(["REQ", subscriptionId, filter]);

    return new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        this.subscriptions.delete(subscriptionId);
        this.eoseHandlers.delete(subscriptionId);
        this.send(["CLOSE", subscriptionId]);
        resolve(events);
      };
      this.eoseHandlers.set(subscriptionId, finish);
      globalThis.setTimeout(finish, timeoutMs);
    });
  }

  handleMessage(message: unknown): boolean {
    if (!isNostrProtocolMessage(message)) return false;
    if (message[0] === "EVENT" && typeof message[1] === "string") {
      if (!message[2]) return true;
      this.subscriptions.get(message[1])?.(message[2]);
      return true;
    }
    if (message[0] === "EOSE") {
      this.eoseHandlers.get(message[1])?.();
      this.eoseHandlers.delete(message[1]);
      return true;
    }
    return true;
  }
}

export class PeerRelayNostrClient {
  constructor(private readonly peer: PeerLike) {}

  async queryRelayStatus(address: string, timeoutMs = 1000): Promise<RelayStatus> {
    const peerId = relayPeerIdFromAddress(address);
    if (!peerId) return { address, live: false };

    const conn = this.peer.connect(peerId, {
      reliable: true,
      serialization: "json",
      metadata: {
        partyP2PRelayProbe: true
      }
    });
    const opened = await waitForOpen(conn, timeoutMs);
    if (!opened) {
      conn.close();
      return { address, live: false };
    }

    return new Promise((resolve) => {
      const requestId = `status_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      let finished = false;
      const finish = (status: RelayStatus) => {
        if (finished) return;
        finished = true;
        conn.close();
        resolve(status);
      };

      conn.on("data", (message: unknown) => {
        const status = message as RelayStatus & { type?: string; requestId?: string };
        if (!status || typeof status !== "object" || status.type !== "relay.status.ok") return;
        if (status.requestId !== requestId) return;
        finish({
          address,
          live: true,
          relayAddress: status.relayAddress,
          roomPeerId: status.roomPeerId,
          relayMeshPeerId: status.relayMeshPeerId,
          relayHints: Array.isArray(status.relayHints) ? status.relayHints.filter((item) => typeof item === "string") : [],
          icedRelayHints: Array.isArray(status.icedRelayHints) ? status.icedRelayHints.filter((item) => typeof item === "string") : [],
          load: status.load
        });
      });
      conn.on("close", () => finish({ address, live: false }));
      conn.on("error", () => finish({ address, live: false }));
      conn.send({ type: "relay.status", requestId });
      globalThis.setTimeout(() => finish({ address, live: false }), timeoutMs);
    });
  }

  async queryRelay(address: string, filter: Filter, timeoutMs = 1500): Promise<RelayQueryResult> {
    const peerId = relayPeerIdFromAddress(address);
    if (!peerId) return { address, live: false, events: [] };

    const conn = this.peer.connect(peerId, {
      reliable: true,
      serialization: "json",
      metadata: {
        partyP2PRelayProbe: true
      }
    });
    const opened = await waitForOpen(conn, timeoutMs);
    if (!opened) {
      conn.close();
      return { address, live: false, events: [] };
    }

    return new Promise((resolve) => {
      const events: Event[] = [];
      const subscriptionId = `probe_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
      let finished = false;
      const finish = (live: boolean) => {
        if (finished) return;
        finished = true;
        try {
          conn.send(["CLOSE", subscriptionId]);
        } catch {
          // The connection may already be closing after a failed probe.
        }
        conn.close();
        resolve({ address, live, events: uniqueEvents(events) });
      };

      conn.on("data", (message: unknown) => {
        if (!isNostrProtocolMessage(message)) return;
        if (message[0] === "EVENT" && message[1] === subscriptionId && message[2]) {
          events.push(message[2]);
          return;
        }
        if (message[0] === "EOSE" && message[1] === subscriptionId) finish(true);
      });
      conn.on("close", () => finish(events.length > 0));
      conn.on("error", () => finish(false));
      conn.send(["REQ", subscriptionId, filter]);
      globalThis.setTimeout(() => finish(events.length > 0), timeoutMs);
    });
  }

  async probeRelay(address: string, filter: Filter, timeoutMs = 1500): Promise<boolean> {
    return (await this.queryRelay(address, { ...filter, limit: 1 }, timeoutMs)).live;
  }

  async queryRelays(addresses: string[], filter: Filter, timeoutMs = 1500): Promise<RelaySetQueryResult> {
    const results = await Promise.all(addresses.map((address) => this.queryRelay(address, filter, timeoutMs)));
    return {
      events: uniqueEvents(results.flatMap((result) => result.events)),
      liveRelays: results.filter((result) => result.live).map((result) => result.address),
      offlineRelays: results.filter((result) => !result.live).map((result) => result.address)
    };
  }

  async publishToRelays(addresses: string[], event: Event, timeoutMs = 1500): Promise<string[]> {
    const liveRelays: string[] = [];
    await Promise.all(addresses.map(async (address) => {
      const peerId = relayPeerIdFromAddress(address);
      if (!peerId) return;
      const conn = this.peer.connect(peerId, {
        reliable: true,
        serialization: "json",
        metadata: {
          partyP2PRelayProbe: true
        }
      });
      if (!(await waitForOpen(conn, timeoutMs))) {
        conn.close();
        return;
      }
      conn.send(["EVENT", event]);
      liveRelays.push(address);
      globalThis.setTimeout(() => conn.close(), 250);
    }));
    return liveRelays;
  }
}

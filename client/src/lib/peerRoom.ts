import Peer from "peerjs";
import type { Filter } from "nostr-tools";
import type { EventState, HostError, HostState, HostWelcome, Mutation, Profile, Role, RoomConfig } from "./types";
import { makeSecretProof } from "./crypto";
import { loadAdminToken, saveAdminToken, saveEncryptedBackup } from "./storage";
import { randomId } from "./id";
import { PeerRelayNostrClient, RoomNostrClient, type DataConnectionLike, type PeerLike, type RelaySetQueryResult } from "./nostrClient";
import { loadKnownRelays, markRelayLive, markRelayOffline, markRelayStatus, rememberRelay, roomPeerIdFromRelayAddress } from "./relayBook";

type Status = "idle" | "connecting" | "connected" | "offline" | "error";
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 8000;
const WELCOME_RETRY_MS = 1000;
const MUTATION_RETRY_MS = 2000;
const DEFAULT_PEERJS_HOST = "0.peerjs.com";

function isTransientPeerError(error: any): boolean {
  const message = error?.message || "";
  return error?.type === "network"
    || error?.type === "peer-unavailable"
    || message.includes("Lost connection to server")
    || message.includes("Could not connect to peer");
}

function peerJsOption(name: string, fallback: string): string {
  const key = `PARTY_P2P_PEERJS_${name}`;
  const value = (globalThis as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : fallback;
}

function debugClient(message: string): void {
  if ((globalThis as Record<string, unknown>).PARTY_P2P_DEBUG === "1") console.debug(`[party-p2p] ${message}`);
}

export class P2PRoomClient {
  private peer?: Peer;
  private conn?: DataConnectionLike;
  private nostr?: RoomNostrClient;
  private relayMesh?: PeerRelayNostrClient;
  private activeRoomPeerId?: string;
  private receivedWelcome = false;
  private destroyed = false;
  private suppressNextCloseReconnect = false;
  private reconnectTimer?: ReturnType<typeof globalThis.setTimeout>;
  private reconnectAttempts = 0;
  private welcomeRetryTimer?: ReturnType<typeof globalThis.setTimeout>;
  private welcomeRetryAttempts = 0;
  private mutationRetryTimer?: ReturnType<typeof globalThis.setTimeout>;
  private readonly pendingMutations = new Map<string, Mutation>();
  private seq = 0;
  private status: Status = "idle";

  constructor(
    private readonly config: RoomConfig,
    private readonly profile: Profile,
    private readonly callbacks: {
      onStatus: (status: Status, detail?: string) => void;
      onState: (state: EventState) => void;
      onRole: (role: Role) => void;
      onError: (message: string) => void;
    }
  ) {}

  async start(): Promise<void> {
    this.setStatus("connecting");
    const peerOptions: Record<string, unknown> = {
      debug: 1,
      host: peerJsOption("HOST", DEFAULT_PEERJS_HOST),
      port: Number(peerJsOption("PORT", "443")),
      path: peerJsOption("PATH", "/"),
      secure: peerJsOption("SECURE", "true") !== "false",
      config: {
        iceServers: this.config.iceServers || [{ urls: "stun:stun.l.google.com:19302" }],
        sdpSemantics: "unified-plan"
      }
    };

    this.peer = new Peer(undefined as unknown as string, peerOptions);

    this.peer.on("open", async () => {
      debugClient(`peer open ${this.peer?.id || ""}`);
      this.relayMesh = new PeerRelayNostrClient(this.peer as unknown as PeerLike);
      this.rememberInitialRelays();
      await this.refreshRelayStatuses();
      this.openRoomConnection(this.selectRoomPeerId());
    });

    this.peer.on("disconnected", () => {
      debugClient("peer disconnected");
      this.setStatus("offline", "Disconnected from the signaling service; existing P2P channels may stay alive.");
      this.peer?.reconnect?.();
      this.scheduleReconnect("Signaling disconnected.");
    });

    this.peer.on("error", (error: any) => {
      debugClient(`peer error ${error?.message || String(error)}`);
      if (isTransientPeerError(error)) return;
      this.setStatus("error", error?.message || String(error));
      this.callbacks.onError(error?.message || String(error));
      this.scheduleReconnect(error?.message || "Peer error.");
    });
  }

  destroy(): void {
    debugClient("destroy");
    this.destroyed = true;
    if (this.reconnectTimer) globalThis.clearTimeout(this.reconnectTimer);
    if (this.welcomeRetryTimer) globalThis.clearTimeout(this.welcomeRetryTimer);
    if (this.mutationRetryTimer) globalThis.clearTimeout(this.mutationRetryTimer);
    this.conn?.close();
    this.peer?.destroy();
  }

  nostrClient(): RoomNostrClient | undefined {
    return this.nostr;
  }

  async queryKnownRelays(filter: Filter, timeoutMs = 1500): Promise<RelaySetQueryResult> {
    if (!this.relayMesh) return { events: [], liveRelays: [], offlineRelays: this.knownRelayAddresses() };
    const result = await this.relayMesh.queryRelays(this.knownRelayAddresses(), filter, timeoutMs);
    for (const address of result.liveRelays) markRelayLive(this.config.roomName, address);
    for (const address of result.offlineRelays) markRelayOffline(this.config.roomName, address);
    this.announceRelayHints(result.liveRelays);
    return result;
  }

  sendMutation(op: Mutation["op"], payload: Record<string, unknown>): void {
    const mutation: Mutation = {
      id: randomId("mut"),
      clientId: this.profile.id,
      seq: ++this.seq,
      ts: Date.now(),
      op,
      payload
    };

    this.pendingMutations.set(mutation.id, mutation);
    this.flushPendingMutations();
    this.scheduleMutationRetry();
    if (!this.conn?.open) this.scheduleReconnect("Mutation queued while offline.");
  }

  private sendMutationMessage(mutation: Mutation): void {
    this.conn?.send({
      type: "client/mutation",
      protocol: 1,
      roomName: this.config.roomName,
      mutation,
      adminToken: loadAdminToken(this.config.roomName)
    });
  }

  private openRoomConnection(roomPeerId: string): void {
    if (!this.peer) return;
    if (this.conn?.open) {
      this.suppressNextCloseReconnect = true;
      this.conn.close();
    }
    const relayHints = this.rememberInitialRelays();
    this.activeRoomPeerId = roomPeerId;
    this.receivedWelcome = false;
    this.welcomeRetryAttempts = 0;
    debugClient(`connecting room ${roomPeerId}`);

    const conn = this.peer.connect(roomPeerId, {
      reliable: true,
      serialization: "json",
      metadata: {
        roomName: this.config.roomName,
        clientId: this.profile.id,
        relayHints
      }
    }) as unknown as DataConnectionLike;

    this.conn = conn;
    this.nostr = new RoomNostrClient((message) => conn.send(message));

    conn.on("open", async () => {
      debugClient(`room open ${roomPeerId}`);
      this.reconnectAttempts = 0;
      this.setStatus("connected");
      await this.sendHello(conn);
      this.scheduleWelcomeRetry(conn);
      void this.refreshRelayStatuses();
    });

    conn.on("data", (data: unknown) => {
      const debugMessage = data as { type?: string };
      if (debugMessage?.type) debugClient(`room data ${debugMessage.type}`);
      if (this.nostr?.handleMessage(data)) return;
      if (this.handleRelayDisconnecting(data)) return;
      if (this.handleRelayHints(data)) return;
      this.handleHostMessage(data);
    });
    conn.on("close", () => {
      debugClient(`room close ${roomPeerId}`);
      if (this.conn !== conn) return;
      this.receivedWelcome = false;
      this.clearWelcomeRetry();
      this.setStatus("offline", "The WebRTC data channel closed.");
      if (this.suppressNextCloseReconnect) {
        this.suppressNextCloseReconnect = false;
        return;
      }
      this.markActiveRelayOffline();
      this.scheduleReconnect("The WebRTC data channel closed.");
    });
    conn.on("error", (error: any) => {
      debugClient(`room error ${roomPeerId} ${error?.message || String(error)}`);
      if (this.conn !== conn) return;
      this.clearWelcomeRetry();
      this.setStatus("error", error?.message || String(error));
      if (!isTransientPeerError(error)) this.callbacks.onError(error?.message || String(error));
      this.markActiveRelayOffline();
      this.scheduleReconnect(error?.message || "Room connection error.");
    });
  }

  private handleHostMessage(data: unknown): void {
    const message = data as HostWelcome | HostState | HostError;
    if (!message || typeof message !== "object" || !("type" in message)) return;

    if (message.type === "host/error") {
      if (message.mutationId) {
        this.pendingMutations.delete(message.mutationId);
        this.scheduleMutationRetry();
      }
      if (message.code === "host-unavailable") {
        this.receivedWelcome = false;
        this.setStatus("connecting", "Waiting for the room host.");
        if (this.conn?.open) this.scheduleWelcomeRetry(this.conn);
        else this.scheduleReconnect("Waiting for the room host.");
        return;
      }
      this.callbacks.onError(message.message);
      return;
    }

    if (message.type === "host/welcome") {
      debugClient(`host welcome ${message.role}`);
      this.receivedWelcome = true;
      this.clearWelcomeRetry();
      if (message.adminToken) {
        saveAdminToken(this.config.roomName, message.adminToken);
      }
      this.callbacks.onRole(message.role);
      this.callbacks.onState(message.state);
      void saveEncryptedBackup(this.config.roomName, this.config.roomSecret, message.state);
      this.flushPendingMutations();
      return;
    }

    if (message.type === "host/state") {
      debugClient(`host state ${message.acceptedMutationId || ""}`);
      if (message.acceptedMutationId) {
        this.pendingMutations.delete(message.acceptedMutationId);
        this.scheduleMutationRetry();
      }
      this.callbacks.onState(message.state);
      void saveEncryptedBackup(this.config.roomName, this.config.roomSecret, message.state);
    }
  }

  private setStatus(status: Status, detail?: string): void {
    this.status = status;
    this.callbacks.onStatus(status, detail);
  }

  private async sendHello(conn: DataConnectionLike): Promise<void> {
    if (this.conn !== conn || !conn.open || this.destroyed) return;
    const secretProof = await makeSecretProof(this.config.roomSecret, this.config.roomName, this.profile.id);
    if (this.conn !== conn || !conn.open || this.destroyed) return;
    conn.send({
      type: "client/hello",
      protocol: 1,
      roomName: this.config.roomName,
      clientId: this.profile.id,
      profile: this.profile,
      secretProof,
      adminToken: loadAdminToken(this.config.roomName),
      relayHints: this.knownRelayAddresses()
    });
    debugClient(`sent hello ${this.profile.name}`);
  }

  private scheduleWelcomeRetry(conn: DataConnectionLike): void {
    this.clearWelcomeRetry();
    if (this.destroyed || this.receivedWelcome) return;
    this.welcomeRetryTimer = globalThis.setTimeout(async () => {
      this.welcomeRetryTimer = undefined;
      if (this.conn !== conn || !conn.open || this.receivedWelcome || this.destroyed) return;
      this.welcomeRetryAttempts += 1;
      if (this.welcomeRetryAttempts >= 3) {
        this.welcomeRetryAttempts = 0;
        void this.refreshRelayStatuses();
        await this.sendHello(conn);
        this.scheduleWelcomeRetry(conn);
        return;
      }
      await this.sendHello(conn);
      this.scheduleWelcomeRetry(conn);
    }, WELCOME_RETRY_MS);
  }

  private clearWelcomeRetry(): void {
    if (!this.welcomeRetryTimer) return;
    globalThis.clearTimeout(this.welcomeRetryTimer);
    this.welcomeRetryTimer = undefined;
  }

  private handleRelayHints(data: unknown): boolean {
    const message = data as { type?: string; relayHints?: unknown };
    if (!message || typeof message !== "object" || message.type !== "relay.hints") return false;
    if (Array.isArray(message.relayHints)) {
      const knownBefore = new Set(this.knownRelayAddresses());
      for (const address of message.relayHints) {
        if (typeof address === "string") rememberRelay(this.config.roomName, address, "relay");
      }
      if (this.knownRelayAddresses().some((address) => !knownBefore.has(address))) void this.refreshRelayStatuses();
    }
    return true;
  }

  private handleRelayDisconnecting(data: unknown): boolean {
    const message = data as { type?: string; relayAddress?: unknown; roomPeerId?: unknown };
    if (!message || typeof message !== "object" || message.type !== "relay.disconnecting") return false;
    const relayAddress = typeof message.relayAddress === "string" ? message.relayAddress : undefined;
    if (relayAddress) markRelayOffline(this.config.roomName, relayAddress);
    debugClient(`relay disconnecting ${relayAddress || ""}`);
    this.receivedWelcome = false;
    this.suppressNextCloseReconnect = true;
    this.conn?.close();
    if (this.activeRoomPeerId !== this.config.roomPeerId) {
      this.openRoomConnection(this.config.roomPeerId);
      return true;
    }
    this.scheduleReconnect("Relay is disconnecting.");
    return true;
  }

  private rememberInitialRelays(): string[] {
    if (this.config.relayAddress) {
      rememberRelay(this.config.roomName, this.config.relayAddress, "invite");
    }
    return this.knownRelayAddresses();
  }

  private knownRelayAddresses(): string[] {
    return loadKnownRelays(this.config.roomName).map((relay) => relay.address);
  }

  private selectRoomPeerId(): string {
    const relays = loadKnownRelays(this.config.roomName)
      .map((relay) => ({
        ...relay,
        roomPeerId: relay.roomPeerId || roomPeerIdFromRelayAddress(relay.address)
      }))
      .filter((relay) => relay.roomPeerId && relay.lastLiveAt && (relay.lastFailedAt || 0) < relay.lastLiveAt);
    const sorted = relays.sort((left, right) => {
      return (left.lastLoad ?? Number.MAX_SAFE_INTEGER) - (right.lastLoad ?? Number.MAX_SAFE_INTEGER)
        || (right.lastLiveAt || 0) - (left.lastLiveAt || 0);
    });
    return sorted.find((relay) => relay.roomPeerId !== this.config.roomPeerId)?.roomPeerId
      || sorted[0]?.roomPeerId
      || this.config.roomPeerId;
  }

  private announceRelayHints(addresses: string[]): void {
    if (!this.conn?.open || addresses.length === 0) return;
    this.conn.send({
      type: "relay.hints",
      roomName: this.config.roomName,
      relayHints: addresses
    });
  }

  private markActiveRelayOffline(): void {
    if (!this.activeRoomPeerId) return;
    markRelayOffline(this.config.roomName, `peerjs:${this.activeRoomPeerId}-relay`);
  }

  private flushPendingMutations(): void {
    if (!this.conn?.open || !this.receivedWelcome) return;
    for (const mutation of this.pendingMutations.values()) this.sendMutationMessage(mutation);
  }

  private scheduleMutationRetry(): void {
    if (this.mutationRetryTimer) {
      globalThis.clearTimeout(this.mutationRetryTimer);
      this.mutationRetryTimer = undefined;
    }
    if (this.pendingMutations.size === 0 || this.destroyed) return;
    this.mutationRetryTimer = globalThis.setTimeout(() => {
      this.mutationRetryTimer = undefined;
      this.flushPendingMutations();
      this.scheduleMutationRetry();
    }, MUTATION_RETRY_MS);
  }

  private scheduleReconnect(detail: string): void {
    if (this.destroyed || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempts, RECONNECT_MAX_MS);
    this.reconnectAttempts += 1;
    this.setStatus("connecting", detail);
    this.reconnectTimer = globalThis.setTimeout(async () => {
      this.reconnectTimer = undefined;
      if (this.destroyed || !this.peer || this.peer.destroyed) return;
      await this.refreshRelayStatuses();
      this.openRoomConnection(this.selectRoomPeerId());
    }, delay);
  }

  private async refreshRelayStatuses(): Promise<void> {
    if (!this.relayMesh) return;
    const addresses = this.knownRelayAddresses();
    await Promise.all(addresses.map(async (address) => {
      const status = await this.relayMesh?.queryRelayStatus(address);
      if (status?.live) {
        markRelayStatus(this.config.roomName, status.relayAddress || address, status);
        for (const relayHint of status.relayHints || []) rememberRelay(this.config.roomName, relayHint, "relay");
      } else {
        markRelayOffline(this.config.roomName, address);
      }
    }));
  }
}

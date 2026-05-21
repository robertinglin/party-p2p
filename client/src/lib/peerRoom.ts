import Peer from "peerjs";
import type { EventState, HostError, HostState, HostWelcome, Mutation, Profile, Role, RoomConfig } from "./types";
import { makeSecretProof } from "./crypto";
import { loadAdminToken, saveAdminToken, saveEncryptedBackup } from "./storage";
import { randomId } from "./id";

type Status = "idle" | "connecting" | "connected" | "offline" | "error";

type DataConnectionLike = {
  open: boolean;
  peer: string;
  send: (data: unknown) => void;
  close: () => void;
  on: (event: string, callback: (...args: any[]) => void) => void;
};

export class P2PRoomClient {
  private peer?: Peer;
  private conn?: DataConnectionLike;
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
      config: {
        iceServers: this.config.iceServers || [{ urls: "stun:stun.l.google.com:19302" }],
        sdpSemantics: "unified-plan"
      }
    };

    this.peer = new Peer(undefined as unknown as string, peerOptions);

    this.peer.on("open", async () => {
      this.openRoomConnection();
    });

    this.peer.on("disconnected", () => {
      this.setStatus("offline", "Disconnected from the signaling service; existing P2P channels may stay alive.");
    });

    this.peer.on("error", (error: any) => {
      this.setStatus("error", error?.message || String(error));
      this.callbacks.onError(error?.message || String(error));
    });
  }

  destroy(): void {
    this.conn?.close();
    this.peer?.destroy();
  }

  sendMutation(op: Mutation["op"], payload: Record<string, unknown>): void {
    if (!this.conn?.open) {
      this.callbacks.onError("Not connected to the room host yet.");
      return;
    }

    const mutation: Mutation = {
      id: randomId("mut"),
      clientId: this.profile.id,
      seq: ++this.seq,
      ts: Date.now(),
      op,
      payload
    };

    this.conn.send({
      type: "client/mutation",
      protocol: 1,
      roomName: this.config.roomName,
      mutation,
      adminToken: loadAdminToken(this.config.roomName)
    });
  }

  private openRoomConnection(): void {
    if (!this.peer) return;

    const conn = this.peer.connect(this.config.roomPeerId, {
      reliable: true,
      serialization: "json",
      metadata: {
        roomName: this.config.roomName,
        clientId: this.profile.id
      }
    }) as unknown as DataConnectionLike;

    this.conn = conn;

    conn.on("open", async () => {
      this.setStatus("connected");
      const secretProof = await makeSecretProof(this.config.roomSecret, this.config.roomName, this.profile.id);
      conn.send({
        type: "client/hello",
        protocol: 1,
        roomName: this.config.roomName,
        clientId: this.profile.id,
        profile: this.profile,
        secretProof,
        adminToken: loadAdminToken(this.config.roomName)
      });
    });

    conn.on("data", (data: unknown) => this.handleHostMessage(data));
    conn.on("close", () => this.setStatus("offline", "The WebRTC data channel closed."));
    conn.on("error", (error: any) => {
      this.setStatus("error", error?.message || String(error));
      this.callbacks.onError(error?.message || String(error));
    });
  }

  private handleHostMessage(data: unknown): void {
    const message = data as HostWelcome | HostState | HostError;
    if (!message || typeof message !== "object" || !("type" in message)) return;

    if (message.type === "host/error") {
      this.callbacks.onError(message.message);
      return;
    }

    if (message.type === "host/welcome") {
      if (message.adminToken) {
        saveAdminToken(this.config.roomName, message.adminToken);
      }
      this.callbacks.onRole(message.role);
      this.callbacks.onState(message.state);
      void saveEncryptedBackup(this.config.roomName, this.config.roomSecret, message.state);
      return;
    }

    if (message.type === "host/state") {
      this.callbacks.onState(message.state);
      void saveEncryptedBackup(this.config.roomName, this.config.roomSecret, message.state);
    }
  }

  private setStatus(status: Status, detail?: string): void {
    this.status = status;
    this.callbacks.onStatus(status, detail);
  }
}

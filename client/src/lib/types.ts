export type Role = "admin" | "guest";
export type Rsvp = "yes" | "maybe" | "no" | "unset";

export type LocationPin = {
  lat: number;
  lng: number;
  zoom: number;
};

export type RoomConfig = {
  roomPeerId: string;
  roomName: string;
  roomSecret: string;
  iceServers?: RTCIceServer[];
};

export type SavedInvite = {
  id: string;
  config: RoomConfig;
  openedAt?: number;
  lastOpenedAt?: number;
  acceptedAt?: number;
  lastJoinedAt?: number;
  profile?: Profile;
  details?: EventDetails;
  stateUpdatedAt?: number;
};

export type Guest = {
  id: string;
  peerId?: string;
  name: string;
  avatar: string;
  rsvp: Rsvp;
  role: Role;
  joinedAt: number;
  lastSeenAt: number;
  nameLocked?: boolean;
  chatDisabled?: boolean;
};

export type EventDetails = {
  id: string;
  roomName: string;
  title: string;
  date: string;
  time: string;
  location: string;
  description: string;
  coverEmoji: string;
  dressCode: string;
  hostNote: string;
  locationPin?: LocationPin;
  theme: "sunset" | "mint" | "violet" | "citrus";
};

export type Post = {
  id: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
  deleted?: boolean;
  pinned?: boolean;
};

export type Comment = {
  id: string;
  postId?: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: number;
  deleted?: boolean;
};

export type EventState = {
  version: number;
  updatedAt: number;
  details: EventDetails;
  guests: Record<string, Guest>;
  posts: Post[];
  comments: Comment[];
  adminIds: string[];
};

export type Profile = {
  id: string;
  name: string;
  avatar: string;
};

export type Mutation = {
  id: string;
  clientId: string;
  seq: number;
  ts: number;
  op:
    | "guest.update"
    | "guest.moderate"
    | "event.update"
    | "post.add"
    | "post.delete"
    | "post.pin"
    | "comment.add"
    | "comment.delete";
  payload: Record<string, unknown>;
};

export type ClientHello = {
  type: "client/hello";
  protocol: 1;
  roomName: string;
  clientId: string;
  profile: Profile;
  secretProof: string;
  adminToken?: string;
};

export type ClientMutation = {
  type: "client/mutation";
  protocol: 1;
  roomName: string;
  mutation: Mutation;
  adminToken?: string;
};

export type HostWelcome = {
  type: "host/welcome";
  protocol: 1;
  state: EventState;
  role: Role;
  clientId: string;
  adminToken?: string;
  message?: string;
};

export type HostState = {
  type: "host/state";
  protocol: 1;
  state: EventState;
  acceptedMutationId?: string;
};

export type HostError = {
  type: "host/error";
  protocol: 1;
  code: string;
  message: string;
};

export type WireMessage = ClientHello | ClientMutation | HostWelcome | HostState | HostError;

import { DurableObject } from "cloudflare:workers";

const ROOM_PATH_RE = /^\/r\/([A-Za-z0-9_-]{10,64})$/;
const ENVELOPE_HEADER_LENGTH = 4;
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_CONTROL = JSON.stringify({ t: "ping" });
const HOST_RECONNECT_GRACE_MS = 120_000;
const HOST_GRACE_STORAGE_KEY = "hostGraceUntil";
const MAX_PENDING_HOST_FRAMES = 256;

type RelayRole = "host" | "guest";

interface SocketAttachment {
	roomId: string;
	role: RelayRole;
	peerId: number;
}

interface RoomState {
	host: WebSocket | null;
	guests: Map<number, WebSocket>;
	nextPeerId: number;
	hostGraceUntil: number | null;
	pendingHostFrames: ArrayBuffer[];
}

function unpackEnvelope(data: ArrayBuffer): { peerId: number } | null {
	if (data.byteLength < ENVELOPE_HEADER_LENGTH) return null;
	return { peerId: new DataView(data, 0, ENVELOPE_HEADER_LENGTH).getUint32(0, false) };
}

function rewriteEnvelopePeer(data: ArrayBuffer, peerId: number): void {
	new DataView(data, 0, ENVELOPE_HEADER_LENGTH).setUint32(0, peerId, false);
}

function parseRelayRequest(request: Request): { roomId: string; role: RelayRole } | null {
	const url = new URL(request.url);
	const match = ROOM_PATH_RE.exec(url.pathname);
	const role = url.searchParams.get("role");
	if (!match || (role !== "host" && role !== "guest")) return null;
	return { roomId: match[1]!, role };
}

export class CollabRelayRoom extends DurableObject<Env> {
	#room: RoomState;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#room = this.#loadRoomState();
	}

	async fetch(request: Request): Promise<Response> {
		const parsed = parseRelayRequest(request);
		if (!parsed) return new Response("not found", { status: 404 });
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("websocket upgrade required", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);
		server.binaryType = "arraybuffer";
		this.ctx.acceptWebSocket(server);
		await this.#open(server, parsed.roomId, parsed.role);
		await this.#scheduleHeartbeat();

		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message === "string") return;
		const attachment = this.#attachment(ws);
		if (!attachment) return;

		if (attachment.role === "host") {
			if (this.#room.host !== ws) return;
			const envelope = unpackEnvelope(message);
			if (!envelope) return;
			if (envelope.peerId === 0) {
				for (const guest of this.#room.guests.values()) guest.send(message);
			} else {
				this.#room.guests.get(envelope.peerId)?.send(message);
			}
			return;
		}

		if (message.byteLength < ENVELOPE_HEADER_LENGTH) return;
		rewriteEnvelopePeer(message, attachment.peerId);
		if (this.#room.host) {
			this.#room.host.send(message);
			return;
		}
		if ((await this.#hostGraceUntil()) !== null && this.#room.pendingHostFrames.length < MAX_PENDING_HOST_FRAMES) {
			this.#room.pendingHostFrames.push(message);
		}
	}

	async webSocketClose(ws: WebSocket, code: number): Promise<void> {
		this.#close(ws, code);
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.#close(ws);
	}

	async alarm(): Promise<void> {
		const hostGraceUntil =
			this.#room.hostGraceUntil ?? (await this.ctx.storage.get<number>(HOST_GRACE_STORAGE_KEY)) ?? null;
		if (hostGraceUntil !== null && Date.now() >= hostGraceUntil) {
			await this.#endRoom();
			return;
		}
		this.#sendHeartbeat();
		await this.#scheduleHeartbeat();
	}

	async #open(ws: WebSocket, roomId: string, role: RelayRole): Promise<void> {
		if (role === "host") {
			if (this.#room.host) {
				ws.close(4009, "a host is already connected for this room");
				return;
			}
			this.#room.host = ws;
			this.#room.hostGraceUntil = null;
			await this.ctx.storage.delete(HOST_GRACE_STORAGE_KEY);
			ws.serializeAttachment({ roomId, role, peerId: 0 } satisfies SocketAttachment);
			for (const frame of this.#room.pendingHostFrames.splice(0)) ws.send(frame);
			return;
		}

		if (!this.#room.host && this.#room.guests.size === 0 && (await this.#hostGraceUntil()) === null) {
			ws.close(4004, "no such room");
			return;
		}

		const peerId = this.#room.nextPeerId++;
		this.#room.guests.set(peerId, ws);
		ws.serializeAttachment({ roomId, role, peerId } satisfies SocketAttachment);
		this.#room.host?.send(JSON.stringify({ t: "peer-joined", peer: peerId }));
	}

	#close(ws: WebSocket, code = 1005): void {
		const attachment = this.#attachment(ws);
		if (!attachment) return;

		if (attachment.role === "host") {
			if (this.#room.host !== ws) return;
			this.#room.host = null;
			if (code === 1000) {
				void this.#endRoom();
				return;
			}
			void this.#beginHostGrace();
			return;
		}

		if (this.#room.guests.delete(attachment.peerId)) {
			this.#room.host?.send(JSON.stringify({ t: "peer-left", peer: attachment.peerId }));
			void this.#clearHeartbeatIfIdle();
		}
	}

	#sendHeartbeat(): void {
		if (this.#room.host?.readyState === WebSocket.OPEN) this.#room.host.send(HEARTBEAT_CONTROL);
		for (const guest of this.#room.guests.values()) {
			if (guest.readyState === WebSocket.OPEN) guest.send(HEARTBEAT_CONTROL);
		}
	}

	async #scheduleHeartbeat(): Promise<void> {
		const hostGraceUntil = await this.#hostGraceUntil();
		if (this.#socketCount() === 0 && hostGraceUntil === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		const heartbeatAt = Date.now() + HEARTBEAT_INTERVAL_MS;
		await this.ctx.storage.setAlarm(hostGraceUntil === null ? heartbeatAt : Math.min(heartbeatAt, hostGraceUntil));
	}

	async #clearHeartbeatIfIdle(): Promise<void> {
		if (this.#socketCount() === 0 && (await this.#hostGraceUntil()) === null) await this.ctx.storage.deleteAlarm();
	}

	#socketCount(): number {
		return (this.#room.host ? 1 : 0) + this.#room.guests.size;
	}

	async #beginHostGrace(): Promise<void> {
		const hostGraceUntil = Date.now() + HOST_RECONNECT_GRACE_MS;
		this.#room.hostGraceUntil = hostGraceUntil;
		await this.ctx.storage.put(HOST_GRACE_STORAGE_KEY, hostGraceUntil);
		for (const guest of this.#room.guests.values()) guest.close(1012, "host reconnecting");
		this.#room.guests.clear();
		await this.#scheduleHeartbeat();
	}

	async #hostGraceUntil(): Promise<number | null> {
		if (this.#room.hostGraceUntil !== null) return this.#room.hostGraceUntil;
		const stored = await this.ctx.storage.get<number>(HOST_GRACE_STORAGE_KEY);
		if (typeof stored === "number" && Date.now() >= stored) {
			await this.ctx.storage.delete(HOST_GRACE_STORAGE_KEY);
			return null;
		}
		this.#room.hostGraceUntil = typeof stored === "number" ? stored : null;
		return this.#room.hostGraceUntil;
	}

	async #endRoom(): Promise<void> {
		this.#room.host = null;
		this.#room.hostGraceUntil = null;
		this.#room.pendingHostFrames.length = 0;
		await this.ctx.storage.delete(HOST_GRACE_STORAGE_KEY);
		const closure = JSON.stringify({ t: "room-closed" });
		for (const guest of this.#room.guests.values()) {
			guest.send(closure);
			guest.close(4001, "room closed");
		}
		this.#room.guests.clear();
		await this.#clearHeartbeatIfIdle();
	}

	#attachment(ws: WebSocket): SocketAttachment | null {
		const value = ws.deserializeAttachment();
		if (!value || typeof value !== "object") return null;
		const attachment = value as Partial<SocketAttachment>;
		if (
			typeof attachment.roomId !== "string" ||
			(attachment.role !== "host" && attachment.role !== "guest") ||
			typeof attachment.peerId !== "number"
		) {
			return null;
		}
		return attachment as SocketAttachment;
	}

	#loadRoomState(): RoomState {
		const guests = new Map<number, WebSocket>();
		let host: WebSocket | null = null;
		let nextPeerId = 1;

		for (const ws of this.ctx.getWebSockets()) {
			const attachment = this.#attachment(ws);
			if (!attachment) continue;
			if (attachment.role === "host") {
				host = ws;
			} else {
				guests.set(attachment.peerId, ws);
				nextPeerId = Math.max(nextPeerId, attachment.peerId + 1);
			}
		}

		return { host, guests, nextPeerId, hostGraceUntil: null, pendingHostFrames: [] };
	}
}

export default {
	async fetch(request, env): Promise<Response> {
		const parsed = parseRelayRequest(request);
		if (!parsed) {
			if (new URL(request.url).pathname.startsWith("/r/")) return new Response("not found", { status: 404 });
			return env.ASSETS.fetch(request);
		}
		return env.COLLAB_RELAY_ROOM.getByName(parsed.roomId).fetch(request);
	},
} satisfies ExportedHandler<Env>;

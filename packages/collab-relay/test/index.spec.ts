import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

const REQUEST_TIMEOUT_MS = 1_000;

const sockets: WebSocket[] = [];

interface Inbox {
	queue: MessageEvent[];
	waiters: Array<(event: MessageEvent) => void>;
}

const inboxes = new Map<WebSocket, Inbox>();

function packEnvelope(peerId: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(4 + payload.byteLength);
	new DataView(out.buffer).setUint32(0, peerId, false);
	out.set(payload, 4);
	return out;
}

function unpackEnvelope(data: Uint8Array): { peerId: number; payload: Uint8Array } | null {
	if (data.byteLength < 4) return null;
	const peerId = new DataView(data.buffer, data.byteOffset, 4).getUint32(0, false);
	return { peerId, payload: data.subarray(4) };
}

async function socket(path: string): Promise<WebSocket> {
	const response = await SELF.fetch(`https://example.com${path}`, {
		headers: { Upgrade: "websocket" },
	});
	expect(response.status).toBe(101);
	const ws = response.webSocket;
	if (!ws) throw new Error("upgrade response did not include a WebSocket");
	ws.binaryType = "arraybuffer";
	ws.accept();

	const inbox: Inbox = { queue: [], waiters: [] };
	inboxes.set(ws, inbox);
	ws.addEventListener("message", event => {
		const waiter = inbox.waiters.shift();
		if (waiter) waiter(event as MessageEvent);
		else inbox.queue.push(event as MessageEvent);
	});
	sockets.push(ws);
	return ws;
}

function nextMessage(ws: WebSocket, label: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<MessageEvent> {
	const inbox = inboxes.get(ws);
	if (!inbox) throw new Error("socket not created via socket()");
	const queued = inbox.queue.shift();
	if (queued) return Promise.resolve(queued);
	const { promise, resolve, reject } = Promise.withResolvers<MessageEvent>();
	const onEvent = (event: MessageEvent): void => {
		clearTimeout(timer);
		resolve(event);
	};
	const timer = setTimeout(() => {
		const idx = inbox.waiters.indexOf(onEvent);
		if (idx !== -1) inbox.waiters.splice(idx, 1);
		reject(new Error(`timed out waiting for ${label}`));
	}, timeoutMs);
	inbox.waiters.push(onEvent);
	return promise;
}

function waitEvent<T extends Event>(
	ws: WebSocket,
	type: string,
	label: string,
	timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	let timer: ReturnType<typeof setTimeout>;
	const cleanup = (): void => {
		ws.removeEventListener(type, onEvent);
		clearTimeout(timer);
	};
	const onEvent = (event: Event): void => {
		cleanup();
		resolve(event as T);
	};
	timer = setTimeout(() => {
		cleanup();
		reject(new Error(`timed out waiting for ${label}`));
	}, timeoutMs);
	ws.addEventListener(type, onEvent);
	return promise;
}

async function waitText(ws: WebSocket, label: string): Promise<string> {
	const event = await nextMessage(ws, label);
	if (typeof event.data !== "string") throw new Error(`${label} was not TEXT`);
	return event.data;
}

async function waitBinary(ws: WebSocket, label: string): Promise<Uint8Array> {
	const event = await nextMessage(ws, label);
	const data: unknown = event.data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	throw new Error(`${label} was not binary`);
}

function closeSocket(ws: WebSocket): void {
	if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
}

afterEach(() => {
	for (const ws of sockets.splice(0)) closeSocket(ws);
	inboxes.clear();
});

describe("collab relay worker", () => {
	it("serves the frontend while rejecting invalid relay requests and guests before a host creates the room", async () => {
		const room = "RelayRoom_Rejects";
		const frontend = await SELF.fetch("https://example.com/");
		expect(frontend.status).toBe(200);
		expect(frontend.headers.get("content-type")).toContain("text/html");
		expect(await frontend.text()).toContain("<title>omp collab");

		const invalidRelay = await SELF.fetch("https://example.com/r/not-valid?role=host", {
			headers: { Upgrade: "websocket" },
		});
		expect(invalidRelay.status).toBe(404);

		const upgradeRequired = await SELF.fetch(`https://example.com/r/${room}?role=host`);
		expect(upgradeRequired.status).toBe(426);

		const guest = await socket(`/r/${room}?role=guest`);
		const close = await waitEvent<CloseEvent>(guest, "close", "missing-room guest close");
		expect(close.code).toBe(4004);
		expect(close.reason).toBe("no such room");
	});

	it("routes opaque envelopes without decrypting them", async () => {
		const room = "RelayRoom_Routes";
		const host = await socket(`/r/${room}?role=host`);

		const guest1 = await socket(`/r/${room}?role=guest`);
		expect(JSON.parse(await waitText(host, "first peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const guest2 = await socket(`/r/${room}?role=guest`);
		expect(JSON.parse(await waitText(host, "second peer join"))).toEqual({ t: "peer-joined", peer: 2 });

		guest1.send(packEnvelope(0, new Uint8Array([1, 2, 3])));
		const fromGuest = unpackEnvelope(await waitBinary(host, "guest envelope"));
		expect(fromGuest?.peerId).toBe(1);
		expect(fromGuest?.payload).toEqual(new Uint8Array([1, 2, 3]));

		const broadcast1 = waitBinary(guest1, "broadcast to guest 1");
		const broadcast2 = waitBinary(guest2, "broadcast to guest 2");
		host.send(packEnvelope(0, new Uint8Array([9])));
		expect(unpackEnvelope(await broadcast1)?.payload).toEqual(new Uint8Array([9]));
		expect(unpackEnvelope(await broadcast2)?.payload).toEqual(new Uint8Array([9]));

		const targeted = waitBinary(guest2, "targeted guest 2 frame");
		host.send(packEnvelope(2, new Uint8Array([7])));
		expect(unpackEnvelope(await targeted)?.payload).toEqual(new Uint8Array([7]));

		const guest1Next = waitBinary(guest1, "next guest 1 broadcast");
		host.send(packEnvelope(0, new Uint8Array([5])));
		expect(unpackEnvelope(await guest1Next)?.payload).toEqual(new Uint8Array([5]));

		const peerLeft = waitText(host, "peer left");
		guest1.close(1000);
		expect(JSON.parse(await peerLeft)).toEqual({ t: "peer-left", peer: 1 });
	});

	it("enforces one host and closes guests when the room host leaves", async () => {
		const room = "RelayRoom_Enforces";
		const host = await socket(`/r/${room}?role=host`);

		const duplicateHost = await socket(`/r/${room}?role=host`);
		const duplicateClose = await waitEvent<CloseEvent>(duplicateHost, "close", "duplicate host close");
		expect(duplicateClose.code).toBe(4009);
		expect(duplicateClose.reason).toBe("a host is already connected for this room");

		const guest = await socket(`/r/${room}?role=guest`);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const closure = waitText(guest, "room close control");
		const guestClose = waitEvent<CloseEvent>(guest, "close", "guest room close");
		host.close(1000);
		expect(JSON.parse(await closure)).toEqual({ t: "room-closed" });
		expect((await guestClose).code).toBe(4001);
	});

	it("keeps a room recoverable when the host disconnects abnormally", async () => {
		const room = "RelayRoom_Reconnects";
		const host = await socket(`/r/${room}?role=host`);

		const guest = await socket(`/r/${room}?role=guest`);
		expect(JSON.parse(await waitText(host, "peer join"))).toEqual({ t: "peer-joined", peer: 1 });

		const guestReconnectClose = waitEvent<CloseEvent>(guest, "close", "guest reconnect close");
		host.close(1012, "service restart");
		const close = await guestReconnectClose;
		expect(close.code).toBe(1012);
		expect(close.reason).toBe("host reconnecting");

		const reconnectedGuest = await socket(`/r/${room}?role=guest`);
		reconnectedGuest.send(packEnvelope(0, new Uint8Array([4, 5, 6])));

		const replacementHost = await socket(`/r/${room}?role=host`);
		const fromGuest = unpackEnvelope(await waitBinary(replacementHost, "buffered guest envelope"));
		expect(fromGuest?.peerId).toBe(2);
		expect(fromGuest?.payload).toEqual(new Uint8Array([4, 5, 6]));
	});
});

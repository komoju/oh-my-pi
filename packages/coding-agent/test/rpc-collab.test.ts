import { describe, expect, it } from "bun:test";
import type { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { isRpcCollabCommand, RpcCollabController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-collab";
import type { RpcCommand, RpcResponse } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function createSession(relayUrl = ""): AgentSession {
	return {
		settings: {
			get: (key: string) => {
				if (key === "collab.relayUrl") return relayUrl;
				if (key === "collab.webUrl") return "";
				if (key === "collab.displayName") return "rpc-host";
				return "";
			},
		},
		sessionManager: {
			getSessionId: () => "sess-rpc-collab",
			getCwd: () => "/tmp",
			snapshotForReplication: () => ({
				header: { type: "session", id: "sess-rpc-collab", timestamp: new Date().toISOString(), cwd: "/tmp" },
				entries: [],
			}),
			onEntryAppended: undefined,
		},
		isStreaming: false,
		isAborting: false,
		queuedMessageCount: 0,
		sessionName: "rpc-collab",
		model: undefined,
		thinkingLevel: undefined,
		subscribe: () => () => {},
		emitNotice: () => {},
		promptCustomMessage: () => Promise.resolve(),
		abort: () => Promise.resolve(),
		getContextUsage: () => ({ tokens: 0, contextWindow: 0, percent: 0 }),
	} as unknown as AgentSession;
}

function collabData(response: RpcResponse): {
	hosting: boolean;
	link?: string;
	webLink?: string;
	viewLink?: string;
	webViewLink?: string;
	participants: Array<{ name: string; role: string }>;
} {
	expect(response.success).toBe(true);
	if (!response.success) throw new Error(response.error);
	const raw = "data" in response ? response.data : undefined;
	expect(raw).toBeDefined();
	const data = raw as {
		hosting: boolean;
		link?: string;
		webLink?: string;
		viewLink?: string;
		webViewLink?: string;
		participants: unknown[];
	};
	return data as {
		hosting: boolean;
		link?: string;
		webLink?: string;
		viewLink?: string;
		webViewLink?: string;
		participants: Array<{ name: string; role: string }>;
	};
}

function fakeHostFactory() {
	const starts: Array<{ relayUrl: string; webUrl: string }> = [];
	const stops: string[] = [];
	const createHost = (_ctx: InteractiveModeContext): CollabHost => {
		const host = {
			link: "",
			webLink: "",
			viewLink: "",
			webViewLink: "",
			participants: [{ name: "rpc-host", role: "host" as const }],
			start: (relayUrl: string, webUrl = "") => {
				starts.push({ relayUrl, webUrl });
				host.link = `${relayUrl}/r/full`;
				host.webLink = `https://web/#${relayUrl}/r/full`;
				host.viewLink = `${relayUrl}/r/view`;
				host.webViewLink = `https://web/#${relayUrl}/r/view`;
				return Promise.resolve();
			},
			stop: (reason: string) => {
				stops.push(reason);
				return Promise.resolve();
			},
		};
		return host as unknown as CollabHost;
	};
	return { createHost, starts, stops };
}

describe("RPC collab commands", () => {
	it("rejects unknown collab discriminants and idle stop/status", async () => {
		expect(isRpcCollabCommand({ type: "collab_status" })).toBe(true);
		expect(isRpcCollabCommand({ type: "get_state" } as RpcCommand)).toBe(false);

		const { createHost } = fakeHostFactory();
		const controller = new RpcCollabController({ session: createSession(), createHost });
		const idle = await controller.dispatch({ id: "s1", type: "collab_status" });
		expect(collabData(idle)).toEqual({ hosting: false, participants: [] });

		const stop = await controller.dispatch({ id: "s2", type: "collab_stop" });
		expect(stop).toMatchObject({
			success: false,
			command: "collab_stop",
			error: "Not hosting a collab session",
		});

		const start = await controller.dispatch({ id: "s3", type: "collab_start" });
		expect(start).toMatchObject({
			success: false,
			command: "collab_start",
			error: "No relay configured. Set collab.relayUrl or pass relayUrl.",
		});
	});

	it("hosts, re-returns the same links, and stops", async () => {
		const host = fakeHostFactory();
		const controller = new RpcCollabController({ session: createSession(), createHost: host.createHost });

		const started = collabData(
			await controller.dispatch({ id: "c1", type: "collab_start", relayUrl: "ws://localhost:8787" }),
		);
		expect(host.starts).toEqual([{ relayUrl: "ws://localhost:8787", webUrl: "" }]);
		expect(started).toEqual({
			hosting: true,
			link: "ws://localhost:8787/r/full",
			webLink: "https://web/#ws://localhost:8787/r/full",
			viewLink: "ws://localhost:8787/r/view",
			webViewLink: "https://web/#ws://localhost:8787/r/view",
			participants: [{ name: "rpc-host", role: "host" }],
		});

		const again = collabData(await controller.dispatch({ id: "c2", type: "collab_start" }));
		expect(host.starts).toHaveLength(1);
		expect(again).toEqual(started);
		expect(collabData(await controller.dispatch({ id: "c3", type: "collab_status" }))).toEqual(started);

		const stopped = collabData(await controller.dispatch({ id: "c4", type: "collab_stop" }));
		expect(host.stops).toEqual(["host stopped"]);
		expect(stopped).toEqual({ hosting: false, participants: [] });
		expect(collabData(await controller.dispatch({ id: "c5", type: "collab_status" }))).toEqual({
			hosting: false,
			participants: [],
		});
	});

	it("prefixes scheme-less relay hosts with wss and uses collab.relayUrl", async () => {
		const host = fakeHostFactory();
		const configured = new RpcCollabController({
			session: createSession("relay.example.com"),
			createHost: host.createHost,
		});
		const fromSettings = collabData(await configured.dispatch({ id: "c6", type: "collab_start" }));
		expect(host.starts[0]?.relayUrl).toBe("wss://relay.example.com");
		expect(fromSettings.hosting).toBe(true);

		const explicit = new RpcCollabController({ session: createSession(), createHost: host.createHost });
		await explicit.dispatch({ id: "c7", type: "collab_start", relayUrl: "custom.example" });
		expect(host.starts[1]?.relayUrl).toBe("wss://custom.example");
	});
});

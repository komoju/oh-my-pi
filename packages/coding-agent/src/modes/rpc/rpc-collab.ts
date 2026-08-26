/**
 * RPC collab hosting. Isolated so rebases against upstream rpc-mode/rpc-types
 * only need the small intercept + union members.
 */
import type { CollabHost } from "../../collab/host";
import type { AgentSession } from "../../session/agent-session";
import type { EventBus } from "../../utils/event-bus";
import type { InteractiveModeContext } from "../types";
import type { RpcCollabStatus, RpcCommand, RpcResponse } from "./rpc-types";

export type RpcCollabCommand = Extract<
	RpcCommand,
	{ type: "collab_start" } | { type: "collab_stop" } | { type: "collab_status" }
>;

const COLLAB_COMMAND_TYPES: Record<RpcCollabCommand["type"], true> = {
	collab_start: true,
	collab_stop: true,
	collab_status: true,
};

export function isRpcCollabCommand(command: RpcCommand): command is RpcCollabCommand {
	return command.type in COLLAB_COMMAND_TYPES;
}

function success(id: string | undefined, command: RpcCollabCommand["type"], data: RpcCollabStatus): RpcResponse {
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

function error(id: string | undefined, command: RpcCollabCommand["type"], message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

function snapshot(host: CollabHost | undefined): RpcCollabStatus {
	if (!host) return { hosting: false, participants: [] };
	return {
		hosting: true,
		link: host.link,
		webLink: host.webLink,
		viewLink: host.viewLink,
		webViewLink: host.webViewLink,
		participants: host.participants,
	};
}

function resolveRelayUrl(explicit: string | undefined, configured: string): string | { error: string } {
	const relayInput = (explicit ?? "").trim() || configured.trim();
	if (!relayInput) {
		return { error: "No relay configured. Set collab.relayUrl or pass relayUrl." };
	}
	return relayInput.includes("://") ? relayInput : `wss://${relayInput}`;
}

function createRpcCollabHostContext(
	session: AgentSession,
	eventBus: EventBus | undefined,
	holder: { host: CollabHost | undefined },
): InteractiveModeContext {
	return {
		settings: session.settings,
		sessionManager: session.sessionManager,
		session,
		eventBus,
		get collabHost() {
			return holder.host;
		},
		set collabHost(value) {
			holder.host = value;
		},
		statusLine: {
			setCollabStatus: () => {},
			invalidate: () => {},
			getCachedContextBreakdown: () => {
				const usage = session.getContextUsage();
				return {
					usedTokens: usage?.tokens ?? 0,
					contextWindow: usage?.contextWindow ?? 0,
				};
			},
		},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		updatePendingMessagesDisplay: () => {},
	} as unknown as InteractiveModeContext;
}

export type RpcCollabHostFactory = (ctx: InteractiveModeContext) => CollabHost;

/** Hosts a collab session from RPC mode without a TUI. */
export class RpcCollabController {
	readonly #session: AgentSession;
	readonly #createHost: RpcCollabHostFactory;
	readonly #holder: { host: CollabHost | undefined } = { host: undefined };
	readonly #ctx: InteractiveModeContext;

	constructor(options: { session: AgentSession; eventBus?: EventBus; createHost: RpcCollabHostFactory }) {
		this.#session = options.session;
		this.#createHost = options.createHost;
		this.#ctx = createRpcCollabHostContext(options.session, options.eventBus, this.#holder);
	}

	async dispatch(command: RpcCollabCommand): Promise<RpcResponse> {
		const id = command.id;
		switch (command.type) {
			case "collab_status":
				return success(id, "collab_status", snapshot(this.#holder.host));
			case "collab_stop":
				return this.#stop(id);
			case "collab_start":
				return this.#start(id, command.relayUrl);
		}
	}

	async dispose(): Promise<void> {
		if (!this.#holder.host) return;
		await this.#holder.host.stop("rpc shutdown");
		this.#holder.host = undefined;
	}

	async #start(id: string | undefined, relayUrl: string | undefined): Promise<RpcResponse> {
		if (this.#holder.host) {
			return success(id, "collab_start", snapshot(this.#holder.host));
		}
		const resolved = resolveRelayUrl(relayUrl, this.#session.settings.get("collab.relayUrl") || "");
		if (typeof resolved !== "string") {
			return error(id, "collab_start", resolved.error);
		}
		const webUrl = this.#session.settings.get("collab.webUrl") || "";
		const host = this.#createHost(this.#ctx);
		try {
			await host.start(resolved, webUrl);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return error(id, "collab_start", `Failed to start collab session: ${message}`);
		}
		this.#ctx.collabHost = host;
		return success(id, "collab_start", snapshot(host));
	}

	async #stop(id: string | undefined): Promise<RpcResponse> {
		const host = this.#holder.host;
		if (!host) {
			return error(id, "collab_stop", "Not hosting a collab session");
		}
		await host.stop("host stopped");
		this.#holder.host = undefined;
		return success(id, "collab_stop", snapshot(undefined));
	}
}

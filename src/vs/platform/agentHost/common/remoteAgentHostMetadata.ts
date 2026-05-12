/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { PROTOCOL_VERSION } from './state/protocol/version/registry.js';

export const remoteAgentHostStateSchemaVersion = 1;

/**
 * Persisted record describing a running `code agent host` proxy, written to
 * the per-quality lockfile (`~/<dataFolderName>/cli/agent-host-<quality>.lock`).
 *
 * This schema is shared with the Rust CLI in
 * `cli/src/tunnels/agent_host_metadata.rs`; field renames or removals MUST be
 * coordinated across both languages.
 */
export interface IRemoteAgentHostState {
	readonly schemaVersion: typeof remoteAgentHostStateSchemaVersion;
	readonly pid: number;
	readonly port: number;
	readonly connectionToken?: string | null;
	readonly protocolVersion: string;
	readonly quality?: string;
	readonly tunnelName?: string;
}

export function createRemoteAgentHostState(options: {
	readonly pid: number;
	readonly port: number;
	readonly connectionToken: string | undefined;
	readonly quality?: string;
	readonly tunnelName?: string;
}): IRemoteAgentHostState {
	return {
		schemaVersion: remoteAgentHostStateSchemaVersion,
		pid: options.pid,
		port: options.port,
		connectionToken: options.connectionToken ?? null,
		protocolVersion: PROTOCOL_VERSION,
		quality: options.quality,
		tunnelName: options.tunnelName,
	};
}

export function parseRemoteAgentHostState(raw: unknown): IRemoteAgentHostState | undefined {
	if (typeof raw !== 'object' || raw === null) {
		return undefined;
	}

	const obj = raw as Record<string, unknown>;
	if (obj.schemaVersion !== remoteAgentHostStateSchemaVersion) {
		return undefined;
	}
	if (typeof obj.pid !== 'number' || !Number.isSafeInteger(obj.pid) || obj.pid <= 0) {
		return undefined;
	}
	if (typeof obj.port !== 'number' || !Number.isSafeInteger(obj.port) || obj.port <= 0 || obj.port > 65535) {
		return undefined;
	}
	if (obj.connectionToken !== undefined && obj.connectionToken !== null && typeof obj.connectionToken !== 'string') {
		return undefined;
	}
	if (typeof obj.protocolVersion !== 'string') {
		return undefined;
	}
	if (obj.quality !== undefined && typeof obj.quality !== 'string') {
		return undefined;
	}
	if (obj.tunnelName !== undefined && typeof obj.tunnelName !== 'string') {
		return undefined;
	}

	return {
		schemaVersion: remoteAgentHostStateSchemaVersion,
		pid: obj.pid,
		port: obj.port,
		connectionToken: (obj.connectionToken as string | null | undefined) ?? null,
		protocolVersion: obj.protocolVersion,
		quality: obj.quality,
		tunnelName: obj.tunnelName,
	};
}

export function isRemoteAgentHostStateCompatible(state: IRemoteAgentHostState, protocolVersion = PROTOCOL_VERSION): boolean {
	return state.protocolVersion === protocolVersion;
}

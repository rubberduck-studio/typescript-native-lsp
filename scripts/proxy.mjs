/**
 * A stdio proxy between Claude Code and a language server.
 *
 * It spawns the server, forwards every frame in both directions, and lets a list
 * of features observe, rewrite, drop or inject messages. Each feature works
 * around one gap between Claude Code's LSP client and the servers, and each can
 * be removed on its own once that gap is closed upstream. With no features left,
 * the proxy itself can go: launch.mjs then execs the server directly.
 *
 * A feature is created from a context and may implement:
 *   onClient(message)  client-to-server message; return true to forward it as is,
 *                      false to drop it, or a message object to forward instead.
 *                      Features see the message in list order, each receiving
 *                      the previous feature's result.
 *   onServer(message)  server-to-client response to a request whose id starts with
 *                      the feature's own prefix (ctx.requestId); return nothing.
 *   beforeRequest()    runs before the proxy forwards any client request to the
 *                      server, and before a feature's own requests.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';

const KILL_GRACE_MS = 2000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
const ID_PREFIX = 'typescript-native-lsp:';

/**
 * @param {{ command: string, args: string[], log: (message: string) => void, debug?: boolean, features: Array<(ctx: object) => object> }} options
 */
export function runProxy({ command, args, log, debug = false, features }) {
	const server = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
	const listeners = new Map();
	let nextId = 0;

	const ctx = {
		log,
		trace: debug ? log : () => {},
		toServer: message => writeMessage(server.stdin, message),
		toClient: message => writeMessage(process.stdout, message),
		/** A request id the proxy can recognise and keep from the client. */
		requestId: name => `${ID_PREFIX}${name}:${++nextId}`,
		beforeRequest: () => {
			for (const feature of active) {
				feature.beforeRequest?.();
			}
		},
		on(event, handler) {
			listeners.set(event, [...(listeners.get(event) ?? []), handler]);
		},
		emit(event, payload) {
			for (const handler of listeners.get(event) ?? []) {
				handler(payload);
			}
		},
	};
	const active = features.map(create => create(ctx));

	const toServer = createFrameReader({
		wants: () => true,
		inspect(message) {
			if (undefined !== message.id && undefined !== message.method) {
				ctx.beforeRequest();
			}
			let current = message;
			let replaced = false;
			for (const feature of active) {
				if (undefined === feature.onClient) {
					continue;
				}
				const result = feature.onClient(current);
				if (false === result) {
					return false;
				}
				if (true !== result) {
					current = result;
					replaced = true;
				}
			}
			return replaced ? current : true;
		},
		target: server.stdin,
	});

	const toClient = createFrameReader({
		wants: frame => frame.includes(ID_PREFIX),
		inspect(message) {
			if ('string' !== typeof message.id || false === message.id.startsWith(ID_PREFIX)) {
				return true;
			}
			for (const feature of active) {
				feature.onServer?.(message);
			}
			return false;
		},
		target: process.stdout,
	});

	process.stdin.on('data', chunk => guard(() => toServer.push(chunk)));
	process.stdin.on('end', () => server.stdin.end());
	server.stdin.on('error', () => {});
	server.stdout.on('data', chunk => guard(() => toClient.push(chunk)));
	server.on('error', error => {
		log(`failed to start ${command}: ${error.message}`);
		finish(1);
	});
	server.on('close', (code, signal) => {
		if (null !== signal) {
			log(`server exited on ${signal}`);
		}
		finish(exitStatus(code, signal));
	});
	for (const signal of SIGNALS) {
		process.on(signal, () => {
			server.kill(signal);
			setTimeout(() => server.kill('SIGKILL'), KILL_GRACE_MS).unref();
		});
	}

	/** Runs a frame handler; a protocol error ends the session cleanly instead of throwing across the event loop. */
	function guard(handle) {
		try {
			handle();
		} catch (error) {
			log(`protocol error: ${error.message}`);
			server.kill('SIGTERM');
			finish(1);
		}
	}

	/** Stops everything that keeps the event loop alive; Node exits once stdout has drained. */
	function finish(code) {
		process.exitCode = code;
		process.stdin.destroy();
		ctx.emit('shutdown');
	}
}

/**
 * Splits a byte stream into LSP frames without copying more than once per frame.
 * A complete frame is parsed and handed to `inspect` only when `wants(frame)` says
 * it can matter. `inspect` returns true to forward the original bytes unchanged,
 * false to drop the frame, or a message object to forward that instead; frames
 * it never saw are forwarded unchanged.
 */
export function createFrameReader({ wants, inspect, target }) {
	let chunks = [];
	let length = 0;
	let frameEnd = -1;
	let headerEnd = -1;
	return {
		push(chunk) {
			chunks.push(chunk);
			length += chunk.length;
			for (;;) {
				if (-1 === frameEnd) {
					const joined = 1 === chunks.length ? chunks[0] : Buffer.concat(chunks, length);
					chunks = [joined];
					headerEnd = joined.indexOf('\r\n\r\n');
					if (-1 === headerEnd) {
						return;
					}
					const header = joined.subarray(0, headerEnd).toString('ascii');
					const lengthMatch = /Content-Length:\s*(\d+)/i.exec(header);
					if (null === lengthMatch) {
						throw new Error(`LSP frame without Content-Length: ${header}`);
					}
					frameEnd = headerEnd + 4 + Number.parseInt(lengthMatch[1], 10);
				}
				if (length < frameEnd) {
					return;
				}
				const joined = 1 === chunks.length ? chunks[0] : Buffer.concat(chunks, length);
				const frame = joined.subarray(0, frameEnd);
				const rest = joined.subarray(frameEnd);
				chunks = rest.length > 0 ? [rest] : [];
				length = rest.length;
				const bodyStart = headerEnd + 4;
				frameEnd = -1;
				headerEnd = -1;
				if (false === wants(frame)) {
					target.write(frame);
					continue;
				}
				const result = inspect(JSON.parse(frame.subarray(bodyStart).toString('utf8')));
				if (true === result) {
					target.write(frame);
				} else if (false !== result) {
					writeMessage(target, result);
				}
			}
		},
	};
}

export function exitStatus(code, signal) {
	if (null !== signal) {
		return 128 + (os.constants.signals[signal] ?? 0);
	}
	return code ?? 1;
}

function writeMessage(target, message) {
	const body = JSON.stringify(message);
	target.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

/**
 * A minimal TypeScript 7.1 content mapper for tests: a file it handles becomes
 * `export declare const value: "<the file's trimmed text>";`, so a test can see
 * whether the server ran it. It speaks the mapper protocol (initialize,
 * openProject, transform, closeProject) over stdio and nothing more.
 */
const handlers = {
	initialize: () => ({ positionEncoding: 'utf-16', diagnosticSource: 'greeting' }),
	openProject: () => ({}),
	transform: ({ content }) => ({ text: `export declare const value: ${JSON.stringify(content.trim())};\n`, extension: '.ts' }),
	closeProject: () => null,
};

let buffer = Buffer.alloc(0);
process.stdin.on('data', chunk => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf('\r\n\r\n');
		if (-1 === headerEnd) {
			return;
		}
		const length = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1];
		if (undefined === length) {
			throw new Error('a frame without Content-Length');
		}
		const end = headerEnd + 4 + Number(length);
		if (buffer.length < end) {
			return;
		}
		const message = JSON.parse(buffer.subarray(headerEnd + 4, end).toString('utf8'));
		buffer = buffer.subarray(end);
		if (undefined !== message.id) {
			respond(message.id, handlers[message.method]?.(message.params) ?? null);
		}
	}
});

function respond(id, result) {
	const body = JSON.stringify({ jsonrpc: '2.0', id, result });
	process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

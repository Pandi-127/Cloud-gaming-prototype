import { spawn } from "child_process";
import net from "node:net";

// ================= PATHS =================

const GAME_PATH = "D:\\games\\games installer\\INSIDE-AnkerGames\\INSIDE\\INSIDE.exe";

const INJECTOR_PATH =
	"D:\\Projects\\Cloud-Gaming-Prototype\\Injector\\injector\\x64\\Debug\\injector.exe";

// ================= PROTOCOL =================

const HEADER_SIZE = 40;
const MAGIC = 0x4d415246; // 'FRAM'

// safety caps
const MAX_PAYLOAD = 1920 * 1080 * 4 * 2; // ~16MB
const MAX_BUFFER = MAX_PAYLOAD * 2;

// ================= GAME =================

function startGame() {
	return new Promise((resolve, reject) => {
		console.log("Starting game...");
		const game = spawn(GAME_PATH, [], { stdio: "inherit" });
		game.once("error", reject);

		// Outlast needs time (splash → real window)
		setTimeout(resolve, 9000);
	});
}

function injectDLL() {
	return new Promise((resolve, reject) => {
		console.log("Injecting DLL...");
		const injector = spawn(INJECTOR_PATH, [], { stdio: "inherit" });
		injector.once("error", reject);
		injector.once("exit", resolve);
	});
}

function connectPipe() {
	return new Promise((resolve, reject) => {
		console.log("Connecting pipe...");
		const pipe = net.createConnection("\\\\.\\pipe\\frame_pipe");
		pipe.once("connect", () => resolve(pipe));
		pipe.once("error", reject);
	});
}

// ================= PIPE PARSER =================

let buffer = Buffer.alloc(0);
let frameCount = 0;

startGame()
	.then(injectDLL)
	.then(connectPipe)
	.then((pipe) => {
		console.log("Pipe connected, waiting for frames...");

		pipe.on("data", (chunk) => {
			// append new bytes
			buffer = Buffer.concat([buffer, chunk]);

			// hard safety cap
			if (buffer.length > MAX_BUFFER) {
				console.error("Buffer overflow, clearing buffer");
				buffer = Buffer.alloc(0);
				return;
			}

			while (true) {
				// need full header
				if (buffer.length < HEADER_SIZE) break;

				// validate magic
				const magic = buffer.readUInt32LE(0);
				if (magic !== MAGIC) {
					// desync, slide window
					buffer = buffer.slice(1);
					continue;
				}

				const headerSize = buffer.readUInt32LE(4);
				if (headerSize !== HEADER_SIZE) {
					buffer = buffer.slice(1);
					continue;
				}

				const payloadSize = buffer.readUInt32LE(36);
				if (payloadSize <= 0 || payloadSize > MAX_PAYLOAD) {
					buffer = buffer.slice(1);
					continue;
				}

				// wait for full frame
				if (buffer.length < HEADER_SIZE + payloadSize) break;

				// optional: read resolution
				const width = buffer.readUInt32LE(24);
				const height = buffer.readUInt32LE(28);

				frameCount++;
				console.log(
					`Frame ${frameCount} received (${width}x${height}, ${payloadSize} bytes)`,
				);

				// consume frame
				buffer = buffer.slice(HEADER_SIZE + payloadSize);
			}
		});

		pipe.on("close", () => {
			console.log("Pipe closed");
		});
	})
	.catch((err) => {
		console.error("Fatal error:", err);
	});

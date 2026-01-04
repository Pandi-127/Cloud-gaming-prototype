import { spawn } from "child_process";
import net from "node:net";

// ================= PATHS =================

const GAME_PATH =
	"D:\\games\\games installer\\INSIDE-AnkerGames\\INSIDE\\INSIDE.exe";

const INJECTOR_PATH =
	"D:\\Projects\\Cloud-Gaming-Prototype\\Injector\\injector\\x64\\Debug\\injector.exe";

const FFPLAY_PATH =
	"D:\\Projects\\tools-instalers\\installed\\ffmpeg-8.0.1-essentials_build\\bin\\ffplay.exe";

// ================= PROTOCOL =================

const HEADER_SIZE = 40;
const MAGIC = 0x4d415246; // 'FRAM'

// safety caps
const MAX_PAYLOAD = 1920 * 1080 * 4 * 2;
const MAX_BUFFER = MAX_PAYLOAD * 2;

// playback
const TARGET_FPS = 60;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
const PRIME_FRAMES = 3;

// ================= GAME =================

function startGame() {
	return new Promise((resolve, reject) => {
		console.log("Starting game...");
		const game = spawn(GAME_PATH, [], { stdio: "inherit" });
		game.once("error", reject);
		setTimeout(resolve, 2000);
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

// ================= RING BUFFER =================

const MAX_FRAMES = 3;
const frameRing = [];

let lastFrame = null;
let videoWidth = null;
let videoHeight = null;

function pushFrame(frame) {
	frameRing.push(frame);
	if (frameRing.length > MAX_FRAMES) frameRing.shift();
}

function fetchLatestFrame() {
	if (frameRing.length > 0) {
		lastFrame = frameRing[frameRing.length - 1];
	}
	return lastFrame;
}

// ================= F F P L A Y =================

function spawnFFPlay(width, height) {
	console.log(`Spawning ffplay ${width}x${height}`);

	return spawn(
		FFPLAY_PATH,
		[
			"-fflags",
			"nobuffer",
			"-flags",
			"low_delay",
			"-sync",
			"video",

			"-f",
			"rawvideo",
			"-pixel_format",
			"rgba",
			"-video_size",
			`${width}x${height}`,
			"-framerate",
			`${TARGET_FPS}`,
			"-i",
			"-",
		],
		{ stdio: ["pipe", "inherit", "inherit"] },
	);
}

// ================= PIPE PARSER =================

let buffer = Buffer.alloc(0);
let playbackStarted = false;
let ffplay = null;

startGame()
	.then(injectDLL)
	.then(connectPipe)
	.then((pipe) => {
		console.log("Pipe connected, waiting for frames...");

		pipe.on("data", (chunk) => {
			buffer = Buffer.concat([buffer, chunk]);

			if (buffer.length > MAX_BUFFER) {
				console.error("Buffer overflow — clearing");
				buffer = Buffer.alloc(0);
				return;
			}

			while (true) {
				if (buffer.length < HEADER_SIZE) break;

				if (buffer.readUInt32LE(0) !== MAGIC) {
					buffer = buffer.slice(1);
					continue;
				}

				const payloadSize = buffer.readUInt32LE(36);
				if (payloadSize <= 0 || payloadSize > MAX_PAYLOAD) {
					buffer = buffer.slice(1);
					continue;
				}

				if (buffer.length < HEADER_SIZE + payloadSize) break;

				videoWidth = buffer.readUInt32LE(24);
				videoHeight = buffer.readUInt32LE(28);

				const frame = buffer.slice(
					HEADER_SIZE,
					HEADER_SIZE + payloadSize,
				);

				pushFrame(frame);
				buffer = buffer.slice(HEADER_SIZE + payloadSize);

				// ---- START PLAYBACK ONLY WHEN PRIMED ----
				if (!playbackStarted && frameRing.length >= PRIME_FRAMES) {
					startPlayback();
					playbackStarted = true;
				}
			}
		});

		pipe.on("close", () => {
			console.log("Pipe closed");
			if (ffplay) ffplay.stdin.end();
		});
	})
	.catch(console.error);

// ================= PLAYBACK LOOP =================

function startPlayback() {
	ffplay = spawnFFPlay(videoWidth, videoHeight);
	console.log("Starting stable 60 FPS playback loop");

	setInterval(() => {
		if (!ffplay || !ffplay.stdin.writable) return;

		const frame = fetchLatestFrame();
		if (frame) {
			ffplay.stdin.write(frame);
		}
	}, FRAME_INTERVAL_MS);
}

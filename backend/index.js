import { spawn } from "child_process";
import net from "node:net";
import { exec } from "child_process";
import dgram from "node:dgram";
import http from "http";
import fs from "fs";
import path from "path";
import { Server } from "socket.io";
import nodeDataChannel from "node-datachannel";
// ================= PATHS =================

const GAME_PATH =
	"D:\\games\\games installer\\INSIDE-AnkerGames\\INSIDE\\INSIDE.exe";

const INJECTOR_PATH =
	"D:\\Projects\\Cloud-Gaming-Prototype\\Injector\\injector\\x64\\Debug\\injector.exe";

const FFMPEG_PATH =
	"D:\\Projects\\tools-instalers\\installed\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe";

// ================= CONSTANTS =================

const HEADER_SIZE = 40;
const MAGIC = 0x4d415246;

const TARGET_FPS = 60;
const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

const MAX_PAYLOAD = 1920 * 1080 * 4;
const MAX_BUFFER = MAX_PAYLOAD * 2;

const PRIME_FRAMES = 4;

const MIN_QUEUE_SIZE = 2;
const MAX_QUEUE_SIZE = 8;
const TARGET_QUEUE_SIZE = 4;

let dynamicQueueMax = TARGET_QUEUE_SIZE;

let videoWidth = null;
let videoHeight = null;

let frameQueue = [];
let frameCount = 0;
let droppedFrames = 0;

let ffmpeg = null;
let ffmpegReady = true;
let encodingStarted = false;

//================= Globels ===============

let peerconnection = null;
let videoTrack = null;

// ================= GAME =================

function startGame() {
	console.log("Starting game...");
	spawn(GAME_PATH, [], { stdio: "inherit" });
}

function injectDLL() {
	return new Promise((resolve, reject) => {
		console.log("Injecting DLL...");
		const injector = spawn(INJECTOR_PATH, [], { stdio: "inherit" });
		injector.once("exit", resolve);
		injector.once("error", reject);
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

function pushFrame(frame) {
	const frameCopy = Buffer.from(frame);

	if (frameQueue.length >= dynamicQueueMax) {
		if (frameQueue.length >= dynamicQueueMax + 3) {
			while (frameQueue.length >= dynamicQueueMax) {
				frameQueue.shift();
				droppedFrames++;
			}
			console.warn(
				`Emergency drop: queue overflowed to ${frameQueue.length + 3}`,
			);
		}
		droppedFrames++;
		return;
	}

	frameQueue.push(frameCopy);
}

// ================= FFMPEG =================

function spawnFFMPEG(width, height) {
	console.log(
		`Starting FFmpeg NVENC (adaptive, low-latency) ${width}x${height}`,
	);

	const ffmpegProcess = spawn(
		FFMPEG_PATH,
		[
			"-y",
			"-loglevel",
			"warning",
			"-stats",

			"-fflags",
			"nobuffer",
			"-max_delay",
			"0",

			// ---------- INPUT ----------
			"-f",
			"rawvideo",
			"-pix_fmt",
			"rgba",
			"-video_size",
			`${width}x${height}`,
			"-framerate",
			"60",
			"-thread_queue_size",
			"512",
			"-i",
			"-",

			// ---------- PROCESSING ----------
			"-vf",
			"format=nv12",

			// ---------- NVENC OPTIMIZED ----------
			"-c:v",
			"h264_nvenc",
			"-preset",
			"p2",
			"-tune",
			"ull",
			"-zerolatency",
			"1",
			"-rc",
			"cbr",
			"-b:v",
			"10M",
			"-maxrate",
			"10M",
			"-bufsize",
			"1.5M",
			"-g",
			"60",
			"-bf",
			"0",
			"-refs",
			"1",
			"-delay",
			"0",
			"-forced-idr",
			"1",
			"-profile:v",
			"high",
			"-level",
			"4.2",
			"-spatial-aq",
			"1",
			"-temporal-aq",
			"0",
			"-rc-lookahead",
			"0",
			"-no-scenecut",
			"1",

			// ---------- OUTPUT ----------
			"-f",
			"h264",
			"udp://127.0.0.1:5000",
		],
		{ stdio: ["pipe", "inherit", "inherit"] },
	);

	ffmpegProcess.stdin.on("drain", () => {
		ffmpegReady = true;
	});

	ffmpegProcess.on("error", (err) => {
		console.error("❌ FFmpeg error:", err);
	});

	ffmpegProcess.on("exit", (code) => {
		console.log(`FFmpeg exited with code ${code}`);
	});

	setTimeout(() => {
		exec(
			'wmic process where name="ffmpeg.exe" CALL setpriority "high priority"',
			(err) => {
				if (!err) console.log("✓ FFmpeg priority set to HIGH");
			},
		);
	}, 1000);

	setTimeout(() => {
		exec(
			"ffplay.exe -fflags nobuffer -flags low_delay -framedrop -an udp://127.0.0.1:1234",
			(err) => {
				if (!err) console.log("✓ FFplay spawned");
			},
		);
	}, 1000);

	return ffmpegProcess;
}

// ================= FRAME WRITER =================

function writeFrameToFFmpeg() {
	if (!ffmpeg || !ffmpeg.stdin.writable) return;

	if (!ffmpegReady) {
		return;
	}

	if (frameQueue.length === 0) {
		return;
	}

	const frame = frameQueue.shift();

	ffmpegReady = ffmpeg.stdin.write(frame);
}

// ================= PIPE PARSER =================

function handlePipe(pipe) {
	const buffer = Buffer.allocUnsafe(MAX_BUFFER);
	let writeOffset = 0;

	pipe.on("data", (chunk) => {
		if (writeOffset + chunk.length > buffer.length) {
			console.warn("Buffer overflow - resetting (data loss!)");
			writeOffset = 0;
			return;
		}

		chunk.copy(buffer, writeOffset);
		writeOffset += chunk.length;

		let readOffset = 0;

		while (true) {
			if (writeOffset - readOffset < HEADER_SIZE) break;

			if (buffer.readUInt32LE(readOffset) !== MAGIC) {
				readOffset += 1;
				continue;
			}

			const payloadSize = buffer.readUInt32LE(readOffset + 36);
			if (payloadSize <= 0 || payloadSize > MAX_PAYLOAD) {
				readOffset += 1;
				continue;
			}

			const frameSize = HEADER_SIZE + payloadSize;
			if (writeOffset - readOffset < frameSize) break;

			videoWidth = buffer.readUInt32LE(readOffset + 24);
			videoHeight = buffer.readUInt32LE(readOffset + 28);

			const frame = buffer.subarray(
				readOffset + HEADER_SIZE,
				readOffset + frameSize,
			);

			readOffset += frameSize;
			frameCount++;

			// ===== PRIMING PHASE =====
			if (!encodingStarted) {
				pushFrame(frame);
				if (frameQueue.length >= PRIME_FRAMES) {
					ffmpeg = spawnFFMPEG(videoWidth, videoHeight);

					while (frameQueue.length > 0) {
						const primeFrame = frameQueue.shift();
						ffmpeg.stdin.write(primeFrame);
					}

					encodingStarted = true;
					console.log(
						" Streaming started (adaptive queue mode)",
					);
					console.log(
						`  Resolution: ${videoWidth}x${videoHeight}`,
					);
					console.log(`  Target: ${TARGET_FPS} FPS`);
					console.log(
						`  Queue range: ${MIN_QUEUE_SIZE}-${MAX_QUEUE_SIZE} frames\n`,
					);

					setInterval(writeFrameToFFmpeg, FRAME_INTERVAL_MS);
				}
				continue;
			}

			pushFrame(frame);
		}

		if (readOffset > 0) {
			buffer.copy(buffer, 0, readOffset, writeOffset);
			writeOffset -= readOffset;
		}
	});

	pipe.on("close", () => {
		console.log("\n Pipe closed");
		if (ffmpeg?.stdin.writable) {
			setTimeout(() => {
				ffmpeg.stdin.end();
			}, 1000);
		}
	});

	pipe.on("error", (err) => {
		console.error("❌ Pipe error:", err);
	});
}

//==================* HTTP Server *===============

let server = http.creatServer((reg, res) => {
	if (req === "/") {
		fs.readFile(path, (err, data) => {
			if (err) {
				res.writeHead(500);
				res.end("errer in reading HTML");
			}
			if (data) {
				res.writeHead(200, { "Content-type": "text/html" });
				res.end(data);
			}
		});
	} else if (reg === "/client.js") {
		fs.readFile(path, (errer, data) => {
			if (errer) {
				res.writeHead(500);
				res.end("couldn't read client.js file");
			}
			if (data) {
				res.writeHead(200, {
					"Content-Type": "application/javascript",
				});
				res.end(data);
			}
		});
	} else {
		res.writeHead(404);
		res.end(" request not found");
	}
});

//===================* Socket *===================
let io = Server(server);

io.on("connection", (socket) => {
	if (!peerconnection) {
		initwebrtc();
	}

	peerconnection.onLocalCandidate((candidate, mid) => {
		socket.emit("signal", { type: Candicate, candidate, mid });
	});
	socket.on("offer", (data) => {
		if (data.type == "offer") {
			peerconnection.setRemoteDescription(data.sdp, "offer");
		}
		let offer = peerconnection.setLocalDescription(offer);
	});

	socket.emmit("offer", { type: "answer", sdp: offer });
});

//=======================WEB-RTC==================

function initwebrtc() {
	peerconnection = nodeDataChannel.peerConnection("gameserver", {
		iceservers: [],
	});

	videoTrack = new nodeDataChannel.Video("video", SendOnly);
	videoTrack.addH264Codec(96);
	peerconnection.addTrack(videoTrack);

	peerconnection.onStateChange((state) => {
		console.log("conection Stage:", state);
	});
}

//================= local socket =================

let udpclient = dgram.createSocket("udp4");

udpclient.on("message", (msg, rinfo) => {
	console.log(
		`ffmpeg transmited message ${msg.toString()} from ${rinfo.port} ,${rinfo.address}`,
	);
});

udpclient.on("error", (err) => {
	console.log(`erroe in udp:${err}`);
});

udpclient.bind(5000, "127.0.0.1");

// ================= BOOT =================

(async function main() {
	console.log(" Game Streaming Server\n");
	console.log("Starting game capture pipeline...\n");

	try {
		startGame();
		await injectDLL();
		const pipe = await connectPipe();
		handlePipe(pipe);
	} catch (error) {
		console.error("❌ Startup error:", error);
		process.exit(1);
	}
})();

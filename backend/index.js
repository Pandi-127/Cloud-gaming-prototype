import { spawn, exec } from "child_process";
import net from "node:net";
import dgram from "node:dgram";
import http from "http";
import fs from "fs";
import path from "path";
import { performance } from "node:perf_hooks";
import { Server } from "socket.io";
import { RTCPeerConnection, MediaStreamTrack } from "werift";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const ViGEmClient = require("vigemclient");

// ================= PATHS =================

const GAME_PATH =
	"D:\\games\\games installer\\INSIDE-AnkerGames\\INSIDE\\INSIDE.exe";
const INJECTOR_PATH = path.join(
	process.cwd(),
	"..\\Injector\\injector\\x64\\Debug\\injector.exe",
);
const FFMPEG_PATH =
	"D:\\Projects\\tools-instalers\\installed\\ffmpeg-8.0.1-essentials_build\\bin\\ffmpeg.exe";

// ================= CONSTANTS =================

const HEADER_SIZE = 40;
const MAGIC = 0x4d415246;
const TARGET_FPS = 60;
const MAX_PAYLOAD = 1920 * 1080 * 4;
const MAX_BUFFER = MAX_PAYLOAD * 4;
const PRIME_FRAMES = 4;
const TARGET_QUEUE_SIZE = 4;

const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;

let videoWidth = null;
let videoHeight = null;
let frameQueue = [];
let frameCount = 0;
let droppedFrames = 0;
let ffmpeg = null;
let ffmpegReady = true;
let encodingStarted = false;

let isClientConnected = false;

let lastFrameTime = 0;

//================= Globals ===============

let peerconnection = null;
let videoTrack = null;
let sender = null;
let videoSsrc = null;
let controller = null;

// ================= ZERO-ALLOCATION MEMORY POOL =================

const POOL_SIZE = 12;
const framePool = Array.from({ length: POOL_SIZE }, () =>
	Buffer.allocUnsafe(MAX_PAYLOAD),
);
let poolWriteIndex = 0;

const keyTo_XBOX_Map = {
	W: "UP",
	A: "LEFT",
	S: "DOWN",
	D: "RIGHT",
	SPACE: "A",
	E: "X",
};

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

// ================= FRAME PUSH =================
function pushFrame(frame) {
	if (frameQueue.length >= TARGET_QUEUE_SIZE) {
		frameQueue.shift();
		droppedFrames++;
	}

	const pooledBuffer = framePool[poolWriteIndex];
	frame.copy(pooledBuffer, 0, 0, frame.length);
	frameQueue.push(pooledBuffer.subarray(0, frame.length));
	poolWriteIndex = (poolWriteIndex + 1) % POOL_SIZE;
}

// ================= FFMPEG =================
function spawnFFMPEG(width, height) {
	const ffmpegProcess = spawn(
		FFMPEG_PATH,
		[
			"-probesize",
			"32",
			"-analyzeduration",
			"0",
			"-fflags",
			"nobuffer+flush_packets",

			"-y",
			"-loglevel",
			"warning",
			"-max_delay",
			"0",
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
			"-vf",
			"format=nv12",
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
			"5M",
			"-maxrate",
			"5M",
			"-bufsize",
			"500k",

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
			"baseline",
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
			"-payload_type",
			"96",
			"-f",
			"rtp",
			"udp://127.0.0.1:5000",
		],
		{ stdio: ["pipe", "inherit", "inherit"] },
	);

	ffmpegProcess.stdin.on("drain", () => {
		ffmpegReady = true;

		flushQueueToFFmpeg();
	});

	ffmpegProcess.stdin.on("error", (err) => {
		if (err.code === "EOF" || err.code === "EPIPE") {
			console.warn("FFmpeg input stream closed (EOF).");
			ffmpegReady = false;
		} else {
			console.error("FFmpeg stdin error:", err);
		}
	});

	ffmpegProcess.on("error", (err) => {
		console.error("FFmpeg error:", err);
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

	return ffmpegProcess;
}

function flushQueueToFFmpeg() {
	if (!ffmpeg || !ffmpeg.stdin.writable || !ffmpegReady) return;
	if (frameQueue.length === 0) return;

	const frame = frameQueue.shift();
	ffmpegReady = ffmpeg.stdin.write(frame);
}

// ================= PIPE PARSER =================
function handlePipe(pipe) {
	const buffer = Buffer.allocUnsafe(MAX_BUFFER);
	let writeOffset = 0;

	pipe.on("data", (chunk) => {
		if (!isClientConnected) {
			return;
		}

		if (writeOffset + chunk.length > buffer.length) {
			console.warn("Buffer overflow - resetting");
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

			if (!encodingStarted) {
				pushFrame(frame);
				if (frameQueue.length >= PRIME_FRAMES) {
					ffmpeg = spawnFFMPEG(videoWidth, videoHeight);
					encodingStarted = true;

					setTimeout(() => flushQueueToFFmpeg(), 0);
				}
				continue;
			}

			const now = performance.now();
			if (now - lastFrameTime >= FRAME_INTERVAL_MS) {
				lastFrameTime = now;
				pushFrame(frame);
				flushQueueToFFmpeg();
			} else {
				droppedFrames++;
			}
		}

		if (readOffset > 0) {
			buffer.copy(buffer, 0, readOffset, writeOffset);
			writeOffset -= readOffset;
		}
	});

	pipe.on("close", () => {
		console.log("\nPipe closed");
		if (ffmpeg?.stdin.writable) {
			setTimeout(() => {
				ffmpeg.stdin.end();
			}, 1000);
		}
	});

	pipe.on("error", (err) => console.error("Pipe error:", err));
}

//==================* HTTP Server *===============

let server = http.createServer((req, res) => {
	if (req.url === "/") {
		fs.readFile(
			path.join(process.cwd(), "..", "frontend", "client.html"),
			(err, data) => {
				if (err) {
					res.writeHead(500);
					res.end("error reading HTML");
				} else {
					res.writeHead(200, { "Content-type": "text/html" });
					res.end(data);
				}
			},
		);
	} else if (req.url === "/client.js") {
		fs.readFile(
			path.join(process.cwd(), "..", "frontend", "client.js"),
			(err, data) => {
				if (err) {
					res.writeHead(500);
					res.end("couldn't read client.js");
				} else {
					res.writeHead(200, {
						"Content-Type": "application/javascript",
					});
					res.end(data);
				}
			},
		);
	} else {
		res.writeHead(404);
		res.end("Not found");
	}
});

// ================= SOCKET.IO SIGNALING SERVER =================

let io = new Server(server, {
	cors: { origin: "*" },
});

io.on("connection", (socket) => {
	console.log("Socket connected:", socket.id);
	if (!peerconnection) initWebRTC(socket);
});

// ================= WEBRTC INITIALIZATION =================

function initWebRTC(socket) {
	videoTrack = new MediaStreamTrack({ kind: "video" });

	peerconnection = new RTCPeerConnection({
		iceServers: [],
		codecs: {
			video: [
				{
					mimeType: "video/H264",
					clockRate: 90000,
					payloadType: 96,
					parameters: {
						"packetization-mode": "1",
						"profile-level-id": "42e02a",
					},
				},
			],
		},
	});

	sender = peerconnection.addTrack(videoTrack);

	peerconnection.onIceCandidate.subscribe((candidate) => {
		if (candidate) {
			socket.emit("server-ICE", candidate.toJSON());
		}
	});

	socket.on("offer", async (data) => {
		if (data.type === "offer" || data.type === "Offer") {
			await peerconnection.setRemoteDescription(data);
			await peerconnection.setLocalDescription(
				await peerconnection.createAnswer(),
			);

			const sdp = peerconnection.localDescription.sdp;
			const match = sdp.match(/a=ssrc:(\d+)/);
			if (match) {
				videoSsrc = parseInt(match[1], 10);
				console.log("✓ WebRTC SSRC Negotiated:", videoSsrc);
			}

			socket.emit("answer", {
				type: peerconnection.localDescription.type,
				sdp: peerconnection.localDescription.sdp,
			});
		}
	});

	socket.on("client-ICE", async (data) => {
		if (data.candidate) {
			await peerconnection.addIceCandidate({
				candidate: data.candidate,
				sdpMid: data.sdpMid,
				sdpMLineIndex: data.sdpMLineIndex,
			});
		}
	});

	peerconnection.connectionStateChange.subscribe((state) => {
		console.log("Werift PeerConnection state:", state);

		if (state === "connected") {
			isClientConnected = true;
			console.log("Client ready! Opening the video gates");
		} else if (
			state === "disconnected" ||
			state === "failed" ||
			state === "closed"
		) {
			isClientConnected = false;
			if (ffmpeg) ffmpeg.kill("SIGINT");
			encodingStarted = false;
		}
	});

	peerconnection.onDataChannel.subscribe((dc) => {
		dc.onMessage.subscribe((data) => {
			let input = JSON.parse(data.toString());
			handleController(input.key, input.action);
		});
	});
}

//================= UDP PACKET MANIPULATOR =================

let udpclient = dgram.createSocket("udp4");

udpclient.on("message", (msg) => {
	try {
		if (
			sender &&
			peerconnection?.connectionState === "connected" &&
			videoSsrc
		) {
			const marker = msg.readUInt8(1) & 0x80;
			msg.writeUInt8(marker | 96, 1);
			msg.writeUInt32BE(videoSsrc, 8);

			sender.sendRtp(msg);
		}
	} catch (error) {
		console.loq(" Ignore partial fram");
	}
});

udpclient.on("error", (err) => console.log(`UDP error: ${err}`));

udpclient.bind(5000, "127.0.0.1", () => {
	try {
		udpclient.setRecvBufferSize(20 * 1080 * 1080);
		console.log("✓ UDP Receive Buffer expanded");
	} catch (e) {
		console.warn(
			"Could not expand UDP buffer. Run Node as Administrator.",
		);
	}
});

// ================= BOOT =================

(async function main() {
	console.log("Game Streaming Server\n");
	try {
		startGame();
		await injectDLL();
		const pipe = await connectPipe();
		handlePipe(pipe);
		server.listen(3000, "0.0.0.0", () => {
			console.log("HTTP server listening on: http://127.0.0.1:3000");
		});
	} catch (error) {
		console.error("Startup error:", error);
		process.exit(1);
	}
})();

//===========================| Virtual Controller |====================

try {
	let client = new ViGEmClient();
	client.connect();
	controller = client.createX360Controller();
	controller.updateMode = "manual";
	controller.connect();
	console.log("Controller created");
} catch (e) {
	console.warn(`Error creating controller: ${e}`);
}

function handleController(key, keyValue) {
	if (keyValue === undefined || !key || !controller) {
		return;
	}

	let ispressed = keyValue === 1;

	if (key === "W") {
		controller.axis.leftY.setValue(ispressed ? 32767 : 0);
	} else if (key === "S") {
		controller.axis.leftY.setValue(ispressed ? -32768 : 0);
	} else if (key === "A") {
		controller.axis.leftX.setValue(ispressed ? -32768 : 0);
	} else if (key === "D") {
		controller.axis.leftX.setValue(ispressed ? 32767 : 0);
	} else {
		let x360Key = keyTo_XBOX_Map[key];
		if (x360Key && controller.button[x360Key]) {
			controller.button[x360Key].setValue(ispressed);
		}
	}

	controller.update();
}

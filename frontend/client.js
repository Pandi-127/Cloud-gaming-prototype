// Game Stream Client
class StreamClient {
	constructor() {
		// Configuration
		this.serverUrl = window.location.origin;

		// WebRTC Peer
		this.peer = null;

		// Socket.IO connection
		this.socket = null;

		// UI Elements
		this.elements = {
			video: document.getElementById("videoElement"),
			noStream: document.getElementById("noStream"),
			videoOverlay: document.getElementById("videoOverlay"),
			statusDot: document.getElementById("statusDot"),
			statusText: document.getElementById("statusText"),

			connectBtn: document.getElementById("connectBtn"),
			disconnectBtn: document.getElementById("disconnectBtn"),
			fullscreenBtn: document.getElementById("fullscreenBtn"),

			// Stats
			connState: document.getElementById("connState"),
			iceState: document.getElementById("iceState"),
			signalState: document.getElementById("signalState"),
			bitrate: document.getElementById("bitrate"),
			fps: document.getElementById("fps"),
			packetsLost: document.getElementById("packetsLost"),
			jitter: document.getElementById("jitter"),
			resolution: document.getElementById("resolution"),
			latency: document.getElementById("latency"),

			logContainer: document.getElementById("logContainer"),
		};

		// Stats tracking
		this.stats = {
			lastBytes: 0,
			lastTime: Date.now(),
		};

		this.statsInterval = null;

		this.init();
	}

	init() {
		this.log("info", "Client initialized");

		// Button handlers
		this.elements.connectBtn.addEventListener("click", () =>
			this.connect(),
		);
		this.elements.disconnectBtn.addEventListener("click", () =>
			this.disconnect(),
		);
		this.elements.fullscreenBtn.addEventListener("click", () =>
			this.toggleFullscreen(),
		);

		// Video events
		this.elements.video.addEventListener("loadedmetadata", () => {
			const { videoWidth, videoHeight } = this.elements.video;
			this.elements.resolution.textContent = `${videoWidth}x${videoHeight}`;
			this.log(
				"success",
				`Video loaded: ${videoWidth}x${videoHeight}`,
			);
		});

		this.elements.video.addEventListener("playing", () => {
			this.elements.noStream.style.display = "none";
			this.elements.videoOverlay.style.display = "block";
			this.log("success", "Playback started");
		});
	}

	async connect() {
		try {
			this.updateStatus("connecting", "Connecting...");
			this.log("info", "Connecting to signaling server...");
			this.elements.connectBtn.disabled = true;

			// Connect to Socket.IO server
			this.socket = io(this.serverUrl);

			this.socket.on("connect", () => {
				this.log("success", `Socket connected: ${this.socket.id}`);
				this.initializePeer();
			});

			this.socket.on("disconnect", () => {
				this.log("warning", "Socket disconnected");
				this.handleDisconnect();
			});

			this.socket.on("signal", (data) => {
				this.log("info", "Received signal from server");
				if (this.peer) {
					this.peer.signal(data);
				}
			});

			this.socket.on("error", (error) => {
				this.log("error", `Socket error: ${error}`);
			});
		} catch (error) {
			this.log("error", `Connection failed: ${error.message}`);
			this.handleDisconnect();
		}
	}

	initializePeer() {
		this.log("info", "Creating WebRTC peer...");

		// Create SimplePeer instance (client initiates)
		this.peer = new SimplePeer({
			initiator: true,
			trickle: false,
			config: {
				iceServers: [],
			},
		});

		// Peer events
		this.peer.on("signal", (data) => {
			this.log("info", "Sending offer to server");
			this.socket.emit("offer", data);
		});

		this.peer.on("connect", () => {
			this.log("success", "WebRTC connection established");
			this.updateStatus("connected", "Connected");
			this.elements.disconnectBtn.disabled = false;
			this.elements.fullscreenBtn.disabled = false;
			this.elements.connState.textContent = "Connected";
			this.startStatsMonitoring();
		});

		this.peer.on("stream", (stream) => {
			this.log("success", "Received video stream");
			this.elements.video.srcObject = stream;
		});

		this.peer.on("data", (data) => {
			// For future: handle data channel messages (inputs, etc.)
			console.log("Received data:", data.toString());
		});

		this.peer.on("error", (err) => {
			this.log("error", `Peer error: ${err.message}`);
		});

		this.peer.on("close", () => {
			this.log("warning", "Peer connection closed");
			this.handleDisconnect();
		});

		// Monitor connection state
		if (this.peer._pc) {
			this.peer._pc.oniceconnectionstatechange = () => {
				const state = this.peer._pc.iceConnectionState;
				this.elements.iceState.textContent = state;
				this.log("info", `ICE state: ${state}`);

				if (state === "disconnected" || state === "failed") {
					this.handleDisconnect();
				}
			};

			this.peer._pc.onsignalingstatechange = () => {
				const state = this.peer._pc.signalingState;
				this.elements.signalState.textContent = state;
			};
		}
	}

	startStatsMonitoring() {
		if (this.statsInterval) {
			clearInterval(this.statsInterval);
		}

		this.statsInterval = setInterval(async () => {
			if (!this.peer || !this.peer._pc) return;

			try {
				const stats = await this.peer._pc.getStats();

				stats.forEach((report) => {
					if (
						report.type === "inbound-rtp" &&
						report.kind === "video"
					) {
						// Bitrate calculation
						const now = Date.now();
						const timeDiff =
							(now - this.stats.lastTime) / 1000;

						if (timeDiff > 0 && report.bytesReceived) {
							const bytesDiff =
								report.bytesReceived -
								this.stats.lastBytes;
							const bitrate = Math.round(
								(bytesDiff * 8) / timeDiff / 1000,
							);
							this.elements.bitrate.textContent = `${bitrate} kbps`;

							this.stats.lastBytes = report.bytesReceived;
							this.stats.lastTime = now;
						}

						// Other stats
						if (report.framesPerSecond) {
							this.elements.fps.textContent = Math.round(
								report.framesPerSecond,
							);
						}

						this.elements.packetsLost.textContent =
							report.packetsLost || 0;

						if (report.jitter) {
							this.elements.jitter.textContent = `${Math.round(report.jitter * 1000)}ms`;
						}

						// Estimate latency (rough)
						if (
							report.jitterBufferDelay &&
							report.jitterBufferEmittedCount
						) {
							const delay =
								(report.jitterBufferDelay /
									report.jitterBufferEmittedCount) *
								1000;
							this.elements.latency.textContent = `~${Math.round(delay)}ms`;
						}
					}
				});
			} catch (error) {
				console.error("Stats error:", error);
			}
		}, 1000);
	}

	disconnect() {
		this.log("warning", "Disconnecting...");
		this.cleanup();
	}

	handleDisconnect() {
		this.cleanup();
		this.updateStatus("disconnected", "Disconnected");
		this.elements.connectBtn.disabled = false;
	}

	cleanup() {
		// Stop stats
		if (this.statsInterval) {
			clearInterval(this.statsInterval);
			this.statsInterval = null;
		}

		// Close peer
		if (this.peer) {
			this.peer.destroy();
			this.peer = null;
		}

		// Close socket
		if (this.socket) {
			this.socket.close();
			this.socket = null;
		}

		// Reset UI
		this.elements.video.srcObject = null;
		this.elements.noStream.style.display = "block";
		this.elements.videoOverlay.style.display = "none";
		this.elements.disconnectBtn.disabled = true;
		this.elements.fullscreenBtn.disabled = true;

		// Reset stats
		this.elements.connState.textContent = "Disconnected";
		this.elements.iceState.textContent = "-";
		this.elements.signalState.textContent = "-";
		this.elements.bitrate.textContent = "- kbps";
		this.elements.fps.textContent = "-";
		this.elements.packetsLost.textContent = "-";
		this.elements.jitter.textContent = "-";
		this.elements.resolution.textContent = "-";
		this.elements.latency.textContent = "-";
	}

	toggleFullscreen() {
		if (!document.fullscreenElement) {
			this.elements.video.requestFullscreen();
		} else {
			document.exitFullscreen();
		}
	}

	updateStatus(type, text) {
		this.elements.statusDot.className = `status-dot ${type}`;
		this.elements.statusText.textContent = text;
	}

	log(level, message) {
		const time = new Date().toLocaleTimeString();
		const entry = document.createElement("div");
		entry.className = "log-entry";
		entry.innerHTML = `
            <span class="log-time">${time}</span>
            <span class="log-level ${level}">${level}</span>
            <span class="log-message">${message}</span>
        `;

		this.elements.logContainer.appendChild(entry);
		this.elements.logContainer.scrollTop =
			this.elements.logContainer.scrollHeight;

		console.log(`[${level.toUpperCase()}] ${message}`);
	}
}

// Initialize when page loads
document.addEventListener("DOMContentLoaded", () => {
	window.streamClient = new StreamClient();
});

const socket = io(window.location.origin);
let peer = null;
let dataChannel = null;
let datachannelopen = false;

const vidPlayer = document.getElementById("game-stream");

const buttons = document.querySelectorAll(".btn");

// SOCKET CONNECTION
socket.on("connect", () => {
	console.log("socket connected:", socket.id);
	connectpeer();
});

socket.on("answer", async (data) => {
	if (data.type === "answer" && peer) {
		try {
			await peer.setRemoteDescription(new RTCSessionDescription(data));
		} catch (e) {
			console.error("answer error:", e);
		}
	}
});

socket.on("server-ICE", async (data) => {
	if (data.candidate && peer) {
		try {
			await peer.addIceCandidate(new RTCIceCandidate(data));
		} catch (e) {
			console.error("ICE error:", e);
		}
	}
});

// WebRTC PEER
async function connectpeer() {
	peer = new RTCPeerConnection({ iceServers: [] });

	const transceiver = peer.addTransceiver("video", {
		direction: "recvonly",
	});

	dataChannel = peer.createDataChannel("game-controls", {
		ordered: false,
		maxRetransmits: 0,
	});

	dataChannel.onopen = () => {
		datachannelopen = true;
		console.log("DataChannel Ready");
	};

	peer.onicecandidate = (e) => {
		if (e.candidate) {
			socket.emit("client-ICE", {
				candidate: e.candidate.candidate,
				sdpMid: e.candidate.sdpMid,
				sdpMLineIndex: e.candidate.sdpMLineIndex,
			});
		}
	};

	peer.ontrack = (e) => {
		vidPlayer.srcObject = e.streams[0];
		if (e.receiver && e.receiver.playoutDelayHint !== undefined) {
			e.receiver.playoutDelayHint = 0;
		}
		vidPlayer.play().catch((err) => console.error("play error:", err));
	};

	const offer = await peer.createOffer();
	await peer.setLocalDescription(offer);
	socket.emit("offer", { type: offer.type, sdp: offer.sdp });
}

let keyStates = {};

buttons.forEach((button) => {
	const key = button.dataset.key;
	if (!key) return;

	const upperKey = key.toUpperCase();
	keyStates[upperKey] = 0;

	function handlePress(e) {
		if (e.cancelable) e.preventDefault();
		if (keyStates[upperKey] === 1) return;
		keyStates[upperKey] = 1;
		if (dataChannel && datachannelopen) {
			dataChannel.send(JSON.stringify({ key: upperKey, action: 1 }));
			console.log(`PRESSED ${upperKey}`);
		}
	}

	function handleRelease(e) {
		if (e.cancelable) e.preventDefault();
		if (keyStates[upperKey] === 0) return;
		keyStates[upperKey] = 0;
		if (dataChannel && datachannelopen) {
			dataChannel.send(JSON.stringify({ key: upperKey, action: 0 }));
			console.log(`RELEASED ${upperKey}`);
		}
	}

	button.addEventListener("mousedown", handlePress);
	button.addEventListener("touchstart", handlePress, { passive: false });
	button.addEventListener("mouseup", handleRelease);
	button.addEventListener("touchend", handleRelease);
	button.addEventListener("mouseleave", handleRelease);
	button.addEventListener("touchcancel", handleRelease);
});

const fsBtn = document.getElementById("btn-fs");
fsBtn.addEventListener("click", () => {
	if (!document.fullscreenElement) {
		document.documentElement.requestFullscreen().catch((err) => {
			console.log(
				`Error attempting to enable full-screen mode: ${err.message}`,
			);
		});
	} else {
		document.exitFullscreen();
	}
});

let socket = io("http://localhost:3000");
socket.on("connect", () => {
	console.log("socket connected : ", socket.id);
	connectpeer(socket);
});

async function connectpeer(socket) {
	let peer = new RTCPeerConnection({
		iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
	});
	peer.addTransceiver("video", { direction: "recvonly" });

	let offer = await peer.createOffer({ offerToReceiveVideo: true });
	await peer.setLocalDescription(offer);
	socket.emit("offer", { type: offer.type, sdp: offer.sdp });

	socket.on("answer", (data) => {
		if (data.type === "answer") {
			peer.serRemoteDescription(
				data,
				() => console.log("answer acepted"),
				() => console.log("err on accepting answer from server"),
			);
			console.log("sdp set", data.type);
		}
	});
}

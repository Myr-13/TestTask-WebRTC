const localVideo = document.querySelector("#your-video");
const remoteVideo = document.querySelector("#remote-video");
const statusEl = document.querySelector("#status");
const roomInput = document.querySelector("#room-input");
const joinBtn = document.querySelector("#join-button");
const leaveBtn = document.querySelector("#leave-button");
const cameraBtn = document.querySelector("#open-camera-button");
const layerControls = document.querySelector("#layer-controls");

let localStream = null;
let pc = null;
let ws = null;
let roomName = "";
let amOfferer = false;
let currentLayer = "l";

function log(msg) {
    statusEl.textContent += msg + "\n";
}

function resetState() {
    if (pc) {
        pc.close();
        pc = null;
    }
    amOfferer = false;
    remoteVideo.srcObject = null;
    layerControls.style.display = "none";
    joinBtn.disabled = false;
    leaveBtn.disabled = true;
    roomInput.disabled = false;
}

async function getMedia() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localVideo.srcObject = stream;
        localStream = stream;
        cameraBtn.disabled = true;
        log("Camera opened");
    } catch (e) {
        log("Camera error: " + e.message);
    }
}

function createPC() {
    pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.stunprotocol.org" }] });

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            ws.send(JSON.stringify({ type: "ice-candidate", room: roomName, data: e.candidate }));
        }
    };

    pc.ontrack = (e) => {
        remoteVideo.srcObject = e.streams[0];
        log("Remote track received");
    };

    pc.oniceconnectionstatechange = () => {
        log("ICE state: " + pc.iceConnectionState);
        if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
            resetState();
        }
    };

    pc.onnegotiationneeded = async () => {
        if (!amOfferer) return;
        try {
            await pc.setLocalDescription(await pc.createOffer());
            ws.send(JSON.stringify({ type: "offer", room: roomName, data: pc.localDescription }));
        } catch (e) {
            log("Negotiation error: " + e.message);
        }
    };
}

function addLocalTracks() {
    if (!pc || !localStream) return;
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
}

async function setLayer(rid) {
    if (!pc) return;
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === "video");
    if (!sender) return;
    const params = sender.getParameters();
    if (!params.encodings) return;
    const config = { h: { scale: 1, bitrate: 2_000_000 }, m: { scale: 2, bitrate: 500_000 }, l: { scale: 4, bitrate: 100_000 } }[rid];
    if (!config) return;
    params.encodings[0].scaleResolutionDownBy = config.scale;
    params.encodings[0].maxBitrate = config.bitrate;
    try {
        await sender.setParameters(params);
        currentLayer = rid;
        log("Sending layer: " + rid + " (" + config.scale + "x downscale)");
    } catch (e) {
        log("setLayer error: " + e.message);
    }
}

async function handleOffer(msg) {
    try {
        if (!pc) {
            createPC();
            addLocalTracks();
        }
        await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
        await pc.setLocalDescription(await pc.createAnswer());
        ws.send(JSON.stringify({ type: "answer", room: roomName, data: pc.localDescription }));
        log("Answer sent");
    } catch (e) {
        log("handleOffer error: " + e.message);
    }
}

async function handleAnswer(msg) {
    try {
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(msg.data));
        log("Remote description set");
    } catch (e) {
        log("handleAnswer error: " + e.message);
    }
}

async function handleCandidate(msg) {
    if (!pc) return;
    try {
        await pc.addIceCandidate(msg.data);
    } catch (e) {
        log("addIceCandidate error: " + e.message);
    }
}

function connectSignaling(room) {
    if (ws) ws.close();

    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(protocol + "//" + location.host + "/ws");

    ws.onopen = () => {
        log("Connected to signaling server");
        ws.send(JSON.stringify({ type: "join", room }));
    };

    ws.onclose = () => {
        log("Signaling disconnected");
        resetState();
        ws = null;
    };

    ws.onmessage = async (e) => {
        const msg = JSON.parse(e.data);

        switch (msg.type) {
            case "joined":
                log("Joined as peer " + msg.peer);
                layerControls.style.display = "flex";
                if (msg.peer === "2") {
                    amOfferer = false;
                    createPC();
                    addLocalTracks();
                }
                break;

            case "peer-joined":
                log("Other peer joined");
                amOfferer = true;
                createPC();
                addLocalTracks();
                break;

            case "offer":
                await handleOffer(msg);
                break;

            case "answer":
                await handleAnswer(msg);
                break;

            case "ice-candidate":
                await handleCandidate(msg);
                break;

            case "set-layer":
                await setLayer(msg.data.rid);
                break;

            case "peer-left":
                log("Other peer left");
                resetState();
                break;

            case "error":
                log("Server error: " + msg.message);
                break;
        }
    };
}

cameraBtn.addEventListener("click", getMedia);

joinBtn.addEventListener("click", () => {
    const room = roomInput.value.trim();
    if (!room) return log("Enter a room name");
    if (!localStream) return log("Open camera first");
    roomName = room;
    joinBtn.disabled = true;
    leaveBtn.disabled = false;
    roomInput.disabled = true;
    connectSignaling(room);
});

leaveBtn.addEventListener("click", () => {
    if (ws) {
        ws.send(JSON.stringify({ type: "leave", room: roomName }));
        ws.close();
    }
    resetState();
    layerControls.style.display = "none";
    log("Left room");
});

document.querySelectorAll(".layer-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
        const rid = btn.dataset.rid;
        document.querySelectorAll(".layer-btn").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        log("Requesting layer: " + rid + " from remote");
        ws.send(JSON.stringify({ type: "set-layer", room: roomName, data: { rid } }));
    });
});

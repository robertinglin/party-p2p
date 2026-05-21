const wrtcModule = require("@roamhq/wrtc");
const WebSocketModule = require("ws");
const xhr2Module = require("xhr2");

const wrtc = wrtcModule.default || wrtcModule;
const WebSocket = WebSocketModule.default || WebSocketModule;
const XMLHttpRequest = xhr2Module.XMLHttpRequest || xhr2Module.default?.XMLHttpRequest || xhr2Module;

function installGlobal(name, value, force = false) {
  if (!force && globalThis[name] != null) return;
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true
  });
}

function installPeerJsNodeGlobals() {
  installGlobal("window", globalThis);
  installGlobal("self", globalThis);
  installGlobal("location", {
    protocol: "https:",
    hostname: "0.peerjs.com",
    host: "0.peerjs.com"
  });
  installGlobal("navigator", { userAgent: "node" });
  installGlobal("WebSocket", WebSocket, true);
  installGlobal("XMLHttpRequest", XMLHttpRequest);
  installGlobal("RTCPeerConnection", wrtc.RTCPeerConnection);
  installGlobal("RTCSessionDescription", wrtc.RTCSessionDescription);
  installGlobal("RTCIceCandidate", wrtc.RTCIceCandidate);
}

async function createNodePeer(peerId, iceServers) {
  installPeerJsNodeGlobals();
  const peerjs = await import("peerjs");
  const Peer = peerjs.Peer || peerjs.default?.Peer || peerjs["module.exports"]?.Peer;
  return new Peer(peerId, {
    debug: Number(process.env.PEER_DEBUG || 0),
    config: {
      iceServers,
      sdpSemantics: "unified-plan"
    }
  });
}

module.exports = { createNodePeer };

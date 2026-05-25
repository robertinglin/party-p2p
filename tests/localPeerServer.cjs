const http = require("node:http");
const express = require("express");
const { ExpressPeerServer } = require("peer");

function startLocalPeerServer() {
  const app = express();
  const server = http.createServer(app);
  const peerServer = ExpressPeerServer(server, {
    path: "/"
  });
  app.use("/peerjs", peerServer);

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve({
        host: "127.0.0.1",
        port: address.port,
        path: "/peerjs",
        secure: false,
        close() {
          return new Promise((closeResolve) => server.close(() => closeResolve()));
        }
      });
    });
  });
}

function applyPeerServerEnv(peerServer) {
  process.env.PARTY_P2P_PEERJS_HOST = peerServer.host;
  process.env.PARTY_P2P_PEERJS_PORT = String(peerServer.port);
  process.env.PARTY_P2P_PEERJS_PATH = peerServer.path;
  process.env.PARTY_P2P_PEERJS_SECURE = String(peerServer.secure);
}

module.exports = {
  applyPeerServerEnv,
  startLocalPeerServer
};

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const FLEET = [4, 3, 3, 2, 2, 2, 1, 1, 1, 1];
const SIZE = 10;

function cleanName(value) {
  return String(value || "Капитан").trim().replace(/\s+/g, " ").slice(0, 18) || "Капитан";
}
function newRoomCode() {
  let code;
  do { code = crypto.randomBytes(3).toString("hex").toUpperCase(); } while (rooms.has(code));
  return code;
}
function coordKey(x, y) { return `${x},${y}`; }
function validFleet(ships) {
  if (!Array.isArray(ships) || ships.length !== FLEET.length) return false;
  const lengths = ships.map(s => Number(s.len)).sort((a,b) => b-a);
  if (JSON.stringify(lengths) !== JSON.stringify([...FLEET].sort((a,b) => b-a))) return false;
  const occupied = new Set();
  for (const ship of ships) {
    const x = Number(ship.x), y = Number(ship.y), len = Number(ship.len);
    const horizontal = ship.dir === "h";
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= SIZE || y >= SIZE) return false;
    for (let i = 0; i < len; i++) {
      const cx = x + (horizontal ? i : 0);
      const cy = y + (horizontal ? 0 : i);
      if (cx >= SIZE || cy >= SIZE) return false;
      const k = coordKey(cx, cy);
      if (occupied.has(k)) return false;
      occupied.add(k);
    }
  }
  // Classic rule: ships may not touch, even diagonally.
  for (const k of occupied) {
    const [x,y] = k.split(",").map(Number);
    for (let dx=-1; dx<=1; dx++) for (let dy=-1; dy<=1; dy++) {
      const nx=x+dx, ny=y+dy;
      if (nx<0 || ny<0 || nx>=SIZE || ny>=SIZE) continue;
      const nk=coordKey(nx,ny);
      if (nk !== k && occupied.has(nk)) {
        // Adjacent cells belonging to the same straight ship are allowed.
        const sameShip = ships.some(s => {
          const cells = Array.from({length:Number(s.len)}, (_,i) =>
            coordKey(Number(s.x)+(s.dir==="h"?i:0), Number(s.y)+(s.dir==="h"?0:i)));
          return cells.includes(k) && cells.includes(nk);
        });
        if (!sameShip) return false;
      }
    }
  }
  return true;
}
function boardFromShips(ships) {
  const board = Array.from({length: SIZE}, () => Array(SIZE).fill(0));
  for (const s of ships) for (let i=0; i<s.len; i++) {
    const x=s.x+(s.dir==="h"?i:0), y=s.y+(s.dir==="h"?0:i);
    board[y][x]=1;
  }
  return board;
}
function publicState(room, socketId) {
  const me = room.players.find(p => p.id === socketId);
  if (!me) return null;
  const opponent = room.players.find(p => p.id !== socketId);
  return {
    roomId: room.id,
    phase: room.phase,
    players: room.players.map(p => ({ name: p.name, ready: !!p.board })),
    me: {
      name: me.name,
      board: me.board || null,
      incomingShots: [...me.incomingShots.entries()].map(([key, hit]) => ({ key, hit })),
      shotsMade: [...me.shotsMade.entries()].map(([key, hit]) => ({ key, hit })),
      ready: !!me.board
    },
    opponent: opponent ? { name: opponent.name, ready: !!opponent.board } : null,
    turnName: room.players.find(p => p.id === room.turn)?.name || null,
    isMyTurn: room.turn === socketId,
    winnerName: room.winnerName || null,
    lastShot: room.lastShot || null
  };
}
function emitStates(room) {
  for (const p of room.players) io.to(p.id).emit("state", publicState(room, p.id));
}
function createPlayer(socket, name) {
  return { id: socket.id, name: cleanName(name), board: null, incomingShots: new Map(), shotsMade: new Map() };
}
function removeRoomIfEmpty(room) {
  if (!room.players.length) rooms.delete(room.id);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name } = {}) => {
    const id = newRoomCode();
    const room = { id, players: [createPlayer(socket, name)], phase: "waiting", turn: null, winnerName: null, chat: [] };
    rooms.set(id, room);
    socket.join(id);
    socket.emit("joined", { roomId: id, host: true });
    emitStates(room);
  });

  socket.on("joinRoom", ({ roomId, name } = {}) => {
    const id = String(roomId || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
    const room = rooms.get(id);
    if (!room) return socket.emit("errorMessage", "Комната не найдена. Проверьте ссылку или код.");
    if (room.players.some(p => p.id === socket.id)) return;
    if (room.players.length >= 2) return socket.emit("errorMessage", "В этой комнате уже два игрока.");
    if (room.phase === "finished") return socket.emit("errorMessage", "Эта игра уже завершена. Создайте новую комнату.");
    room.players.push(createPlayer(socket, name));
    room.phase = "placing";
    socket.join(id);
    socket.emit("joined", { roomId: id, host: false });
    io.to(id).emit("chatMessage", { system: true, text: `${cleanName(name)} присоединился к игре.` });
    emitStates(room);
  });

  socket.on("placeFleet", ({ roomId, ships } = {}) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room || room.phase !== "placing") return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.board) return;
    if (!validFleet(ships)) return socket.emit("errorMessage", "Расстановка неверная: проверьте количество кораблей и расстояние между ними.");
    player.board = boardFromShips(ships);
    socket.emit("fleetAccepted");
    if (room.players.length === 2 && room.players.every(p => p.board)) {
      room.phase = "battle";
      room.turn = room.players[0].id;
      io.to(room.id).emit("chatMessage", { system: true, text: "Оба флота готовы. Бой начинается!" });
    }
    emitStates(room);
  });

  socket.on("shoot", ({ roomId, x, y } = {}) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    if (!room || room.phase !== "battle" || room.turn !== socket.id) return;
    const shooter = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id !== socket.id);
    x=Number(x); y=Number(y);
    if (!shooter || !target || !Number.isInteger(x) || !Number.isInteger(y) || x<0 || y<0 || x>=SIZE || y>=SIZE) return;
    const key = coordKey(x,y);
    if (shooter.shotsMade.has(key)) return;
    const hit = target.board[y][x] === 1;
    shooter.shotsMade.set(key, hit);
    target.incomingShots.set(key, hit);
    room.lastShot = { by: shooter.name, x, y, hit };
    let remaining = 0;
    for (let yy=0; yy<SIZE; yy++) for (let xx=0; xx<SIZE; xx++) {
      if (target.board[yy][xx] === 1 && !target.incomingShots.has(coordKey(xx,yy))) remaining++;
    }
    if (remaining === 0) {
      room.phase = "finished";
      room.winnerName = shooter.name;
      room.turn = null;
      io.to(room.id).emit("chatMessage", { system: true, text: `Победа! ${shooter.name} уничтожил весь флот противника.` });
    } else if (!hit) {
      room.turn = target.id;
    }
    emitStates(room);
  });

  socket.on("chatSend", ({ roomId, text } = {}) => {
    const room = rooms.get(String(roomId || "").toUpperCase());
    const player = room && room.players.find(p => p.id === socket.id);
    const message = String(text || "").trim().slice(0, 300);
    if (!room || !player || !message) return;
    io.to(room.id).emit("chatMessage", { name: player.name, text: message, at: Date.now() });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const index = room.players.findIndex(p => p.id === socket.id);
      if (index === -1) continue;
      const leaving = room.players[index];
      room.players.splice(index, 1);
      if (room.players.length) {
        const remaining = room.players[0];
        io.to(remaining.id).emit("chatMessage", { system: true, text: `${leaving.name} отключился. Игра завершена.` });
        if (room.phase === "battle" || room.phase === "placing") {
          room.phase = "finished";
          room.winnerName = remaining.name;
          room.turn = null;
        }
        emitStates(room);
      } else {
        removeRoomIfEmpty(room);
      }
      break;
    }
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Морской бой запущен на порту ${PORT}`));

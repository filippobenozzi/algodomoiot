"use strict";

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const PUBLIC_DIR = path.join(ROOT, "public");
const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const STATE_PATH = path.join(DATA_DIR, "state.json");

const FRAME_START = 0x49;
const FRAME_END = 0x46;
const FRAME_LEN = 14;

const RELAY_COMMANDS = {
  1: 0x51,
  2: 0x52,
  3: 0x53,
  4: 0x54,
  5: 0x65,
  6: 0x66,
  7: 0x67,
  8: 0x68
};

const LIGHT_ACTIONS = {
  on: 0x41,
  off: 0x53,
  pulse: 0x50,
  toggle: 0x55,
  toggle_no_ack: 0x54
};

const SHUTTER_ACTIONS = {
  up: 0x55,
  down: 0x44,
  stop: 0x53
};

const DEFAULT_CONFIG = {
  gateway: {
    host: "127.0.0.1",
    port: 1470,
    timeoutMs: 1200
  },
  apiToken: "cambia-questo-token",
  boards: [
    {
      id: "board-1",
      name: "Scheda 1",
      address: 1,
      inputs: [
        {
          index: 1,
          name: "Ingresso 1",
          room: "Soggiorno",
          enabled: true,
          g2: 0,
          g3: 0,
          g4: 0,
          targetAddress: 1
        }
      ]
    }
  ],
  entities: {
    lights: [
      {
        id: "light-1",
        name: "Luce Soggiorno",
        room: "Soggiorno",
        address: 1,
        relay: 1
      }
    ],
    shutters: [
      {
        id: "shutter-1",
        name: "Tapparella Soggiorno",
        room: "Soggiorno",
        address: 1,
        channel: 1
      }
    ],
    thermostats: [
      {
        id: "thermo-1",
        name: "Termostato Soggiorno",
        room: "Soggiorno",
        address: 1,
        setpoint: 21
      }
    ]
  }
};

const DEFAULT_STATE = {
  boards: {},
  lights: {},
  shutters: {},
  thermostats: {},
  updatedAt: 0
};

let config = DEFAULT_CONFIG;
let state = DEFAULT_STATE;
let stateSaveTimer = null;

bootstrap();

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    console.error("[http]", err);
    json(res, 500, { ok: false, error: err.message || "Errore interno" });
  });
});

const listenPort = toPort(process.env.PORT, 8080);
server.listen(listenPort, () => {
  console.log(`AlgoDomo app in ascolto su http://localhost:${listenPort}`);
});

function bootstrap() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  if (!fs.existsSync(CONFIG_PATH)) {
    writeJson(CONFIG_PATH, DEFAULT_CONFIG);
  }
  if (!fs.existsSync(STATE_PATH)) {
    writeJson(STATE_PATH, DEFAULT_STATE);
  }
  config = normalizeConfig(readJson(CONFIG_PATH, DEFAULT_CONFIG));
  state = normalizeState(readJson(STATE_PATH, DEFAULT_STATE));
}

async function route(req, res) {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", "http://localhost");
  const p = url.pathname;

  if (p === "/") {
    redirect(res, "/control");
    return;
  }

  if (method === "GET" && p === "/config") {
    serveFile(res, path.join(PUBLIC_DIR, "config.html"), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && p === "/control") {
    serveFile(res, path.join(PUBLIC_DIR, "control.html"), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && p === "/health") {
    json(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && p === "/api/config") {
    json(res, 200, config);
    return;
  }

  if (method === "POST" && p === "/api/config") {
    const payload = await readBodyJson(req);
    config = normalizeConfig(payload);
    writeJson(CONFIG_PATH, config);
    json(res, 200, { ok: true, config });
    return;
  }

  if (p.startsWith("/api/")) {
    if (!tokenValid(url.searchParams.get("token"))) {
      json(res, 401, { ok: false, error: "Token non valido" });
      return;
    }

    if (method !== "GET") {
      json(res, 405, { ok: false, error: "Solo GET consentito" });
      return;
    }

    if (p === "/api/status") {
      const refresh = truthy(url.searchParams.get("refresh"));
      const data = await buildStatus(refresh);
      json(res, 200, { ok: true, ...data });
      return;
    }

    if (p === "/api/cmd/light") {
      await apiLight(res, url.searchParams);
      return;
    }

    if (p === "/api/cmd/shutter") {
      await apiShutter(res, url.searchParams);
      return;
    }

    if (p === "/api/cmd/thermostat") {
      await apiThermostat(res, url.searchParams);
      return;
    }

    if (p === "/api/cmd/poll") {
      const address = toAddress(url.searchParams.get("address"), -1);
      if (address < 0) {
        json(res, 400, { ok: false, error: "address mancante" });
        return;
      }
      const poll = await pollBoard(address);
      json(res, 200, { ok: true, poll });
      return;
    }

    if (p === "/api/cmd/apply-inputs") {
      await apiApplyInputs(res, url.searchParams);
      return;
    }

    if (p === "/api/cmd/program-address") {
      const address = toAddress(url.searchParams.get("address"), -1);
      if (address < 0) {
        json(res, 400, { ok: false, error: "address mancante" });
        return;
      }
      const ack = await sendRaw(Buffer.from([address]), { expectFrame: false, expectedBytes: 1 });
      json(res, 200, {
        ok: true,
        programmedAddress: address,
        ack: ack[0],
        ackHex: toHex(ack[0])
      });
      return;
    }

    json(res, 404, { ok: false, error: "Endpoint non trovato" });
    return;
  }

  if (p === "/favicon.ico") {
    res.writeHead(204);
    res.end();
    return;
  }

  json(res, 404, { ok: false, error: "Not found" });
}

async function apiLight(res, params) {
  const action = (params.get("action") || "").trim().toLowerCase();
  const code = LIGHT_ACTIONS[action];
  if (!code) {
    json(res, 400, { ok: false, error: "action non valida" });
    return;
  }

  const light = findLight(params.get("id"), params.get("address"), params.get("relay"));
  if (!light) {
    json(res, 404, { ok: false, error: "Luce non trovata" });
    return;
  }

  const command = RELAY_COMMANDS[light.relay];
  if (!command) {
    json(res, 400, { ok: false, error: "relay non valida" });
    return;
  }

  const frame = await sendFrame(light.address, command, [code]);
  let poll = null;
  try {
    poll = await pollBoard(light.address);
  } catch (err) {
    poll = null;
  }

  const previous = state.lights[light.id] || { isOn: null };
  const isOn = inferLightState(light, poll, previous.isOn, action);

  state.lights[light.id] = {
    isOn,
    updatedAt: Date.now()
  };
  state.updatedAt = Date.now();
  persistStateSoon();

  json(res, 200, {
    ok: true,
    entity: light,
    action,
    frame
  });
}

async function apiShutter(res, params) {
  const action = (params.get("action") || "").trim().toLowerCase();
  const code = SHUTTER_ACTIONS[action];
  if (!code) {
    json(res, 400, { ok: false, error: "action non valida" });
    return;
  }

  const shutter = findShutter(params.get("id"), params.get("address"), params.get("channel"));
  if (!shutter) {
    json(res, 404, { ok: false, error: "Tapparella non trovata" });
    return;
  }

  const frame = await sendFrame(shutter.address, 0x5c, [shutter.channel, code]);
  state.shutters[shutter.id] = {
    action,
    updatedAt: Date.now()
  };
  state.updatedAt = Date.now();
  persistStateSoon();

  json(res, 200, {
    ok: true,
    entity: shutter,
    action,
    frame
  });
}

async function apiThermostat(res, params) {
  const setpointRaw = params.get("set");
  const setpoint = toFiniteFloat(setpointRaw, NaN);
  if (!Number.isFinite(setpoint)) {
    json(res, 400, { ok: false, error: "set mancante o non valido" });
    return;
  }

  const thermostat = findThermostat(params.get("id"), params.get("address"));
  if (!thermostat) {
    json(res, 404, { ok: false, error: "Termostato non trovato" });
    return;
  }

  const split = splitTemperature(setpoint);
  const frame = await sendFrame(thermostat.address, 0x5a, [split.i, split.d]);

  state.thermostats[thermostat.id] = {
    setpoint,
    updatedAt: Date.now()
  };
  state.updatedAt = Date.now();
  persistStateSoon();

  try {
    await pollBoard(thermostat.address);
  } catch (err) {
    // Ignore polling errors after write.
  }

  json(res, 200, {
    ok: true,
    entity: thermostat,
    setpoint,
    frame
  });
}

async function apiApplyInputs(res, params) {
  const boardFilter = (params.get("board") || "").trim();
  const addressFilter = toAddress(params.get("address"), -1);

  const targets = config.boards.filter((b) => {
    if (boardFilter && b.id !== boardFilter) {
      return false;
    }
    if (addressFilter >= 0 && b.address !== addressFilter) {
      return false;
    }
    return true;
  });

  if (targets.length === 0) {
    json(res, 404, { ok: false, error: "Nessuna scheda trovata" });
    return;
  }

  const results = [];

  for (const board of targets) {
    for (const input of board.inputs) {
      if (!input.enabled) {
        continue;
      }
      const gBytes = [
        toByte(input.index, 1),
        toByte(input.g2, 0),
        toByte(input.g3, 0),
        toByte(input.g4, 0),
        toAddress(input.targetAddress, board.address)
      ];

      try {
        const frame = await sendFrame(board.address, 0x55, gBytes);
        results.push({
          ok: true,
          boardId: board.id,
          boardAddress: board.address,
          input: input.index,
          frame
        });
      } catch (err) {
        results.push({
          ok: false,
          boardId: board.id,
          boardAddress: board.address,
          input: input.index,
          error: err.message
        });
      }
    }
  }

  json(res, 200, {
    ok: results.every((r) => r.ok),
    results
  });
}

async function buildStatus(refresh) {
  const addresses = collectAddresses();
  const refreshErrors = [];

  if (refresh) {
    for (const address of addresses) {
      try {
        await pollBoard(address);
      } catch (err) {
        refreshErrors.push({ address, error: err.message });
      }
    }
  }

  const roomMap = new Map();

  for (const light of config.entities.lights) {
    const poll = state.boards[String(light.address)]?.poll || null;
    const lastKnown = state.lights[light.id] || { isOn: null };
    const isOn = inferLightState(light, poll, lastKnown.isOn, null);

    state.lights[light.id] = {
      isOn,
      updatedAt: Date.now()
    };

    const room = getRoom(roomMap, light.room || "Senza stanza");
    room.lights.push({
      id: light.id,
      name: light.name,
      room: light.room,
      address: light.address,
      relay: light.relay,
      isOn
    });
  }

  for (const shutter of config.entities.shutters) {
    const sh = state.shutters[shutter.id] || { action: "unknown" };
    const room = getRoom(roomMap, shutter.room || "Senza stanza");
    room.shutters.push({
      id: shutter.id,
      name: shutter.name,
      room: shutter.room,
      address: shutter.address,
      channel: shutter.channel,
      action: sh.action || "unknown"
    });
  }

  for (const thermostat of config.entities.thermostats) {
    const poll = state.boards[String(thermostat.address)]?.poll || null;
    const latest = state.thermostats[thermostat.id] || { setpoint: thermostat.setpoint || null };
    const room = getRoom(roomMap, thermostat.room || "Senza stanza");

    room.thermostats.push({
      id: thermostat.id,
      name: thermostat.name,
      room: thermostat.room,
      address: thermostat.address,
      temperature: poll ? poll.temperature : null,
      setpoint: Number.isFinite(latest.setpoint) ? latest.setpoint : thermostat.setpoint || null,
      boardSetpoint: poll ? poll.setpoint : null
    });
  }

  for (const board of config.boards) {
    const poll = state.boards[String(board.address)]?.poll || null;
    for (const input of board.inputs) {
      const room = getRoom(roomMap, input.room || "Senza stanza");
      const active = poll ? isInputActive(poll.inputMask, input.index) : null;
      room.inputs.push({
        boardId: board.id,
        boardAddress: board.address,
        index: input.index,
        name: input.name,
        room: input.room,
        active,
        enabled: input.enabled,
        g2: input.g2,
        g3: input.g3,
        g4: input.g4,
        targetAddress: input.targetAddress
      });
    }
  }

  const rooms = Array.from(roomMap.values()).sort((a, b) => a.name.localeCompare(b.name, "it"));
  state.updatedAt = Date.now();
  persistStateSoon();

  return {
    updatedAt: state.updatedAt,
    refreshErrors,
    rooms
  };
}

async function pollBoard(address) {
  const frame = await sendFrame(address, 0x40, []);
  const poll = decodePollingFrame(frame);

  state.boards[String(address)] = {
    address,
    poll,
    updatedAt: Date.now(),
    frameHex: frame.hex
  };

  state.updatedAt = Date.now();
  persistStateSoon();
  return poll;
}

function decodePollingFrame(frame) {
  const g = frame.g;
  const typeAndRelease = toByte(g[0], 0);
  const outputMask = toByte(g[1], 0);
  const inputMask = toByte(g[2], 0);

  const sign = g[6] === 0x2d ? -1 : 1;
  const tempInt = toByte(g[4], 0);
  const tempDec = toByte(g[5], 0);

  return {
    boardType: typeAndRelease & 0x0f,
    release: (typeAndRelease >> 4) & 0x0f,
    outputMask,
    inputMask,
    outputs: decodeBits(outputMask),
    inputs: decodeBits(inputMask),
    dimmer: toByte(g[3], 0),
    temperature: sign * (tempInt + tempDec / 10),
    powerKw: toByte(g[7], 0) / 10,
    setpoint: toByte(g[8], 0)
  };
}

function isInputActive(mask, index) {
  if (!Number.isInteger(index) || index < 1 || index > 8) {
    return null;
  }
  const bit = 1 << (index - 1);
  // Dal protocollo: 0 = attivo, 1 = non attivo.
  return (mask & bit) === 0;
}

function inferLightState(light, poll, fallback, action) {
  if (poll && poll.outputMask !== undefined) {
    const bit = 1 << (light.relay - 1);
    return (poll.outputMask & bit) !== 0;
  }

  if (action === "on") {
    return true;
  }
  if (action === "off") {
    return false;
  }
  if (action === "toggle" && typeof fallback === "boolean") {
    return !fallback;
  }

  return typeof fallback === "boolean" ? fallback : null;
}

async function sendFrame(address, command, gBytes) {
  const payload = buildFrame(address, command, gBytes || []);
  return sendRaw(payload, { expectFrame: true });
}

async function sendRaw(payload, options) {
  const opts = options || {};
  const gateway = config.gateway || DEFAULT_CONFIG.gateway;
  const host = String(gateway.host || "127.0.0.1");
  const port = toPort(gateway.port, 1470);
  const timeoutMs = toTimeout(opts.timeoutMs || gateway.timeoutMs || 1200);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let done = false;
    let received = Buffer.alloc(0);

    const timeout = setTimeout(() => {
      finish(new Error("Timeout comunicazione"));
    }, timeoutMs);

    function finish(err, value) {
      if (done) {
        return;
      }
      done = true;
      clearTimeout(timeout);
      socket.destroy();
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    }

    socket.on("connect", () => {
      socket.write(payload);
    });

    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);

      if (opts.expectFrame !== false) {
        const frame = extractFirstFrame(received);
        if (frame) {
          finish(null, parseFrame(frame));
        }
      } else {
        const expectedBytes = Math.max(1, toNumber(opts.expectedBytes, 1));
        if (received.length >= expectedBytes) {
          finish(null, received.subarray(0, expectedBytes));
        }
      }
    });

    socket.on("error", (err) => {
      finish(err);
    });

    socket.on("close", () => {
      if (done) {
        return;
      }

      if (opts.expectFrame !== false) {
        const frame = extractFirstFrame(received);
        if (frame) {
          finish(null, parseFrame(frame));
          return;
        }
        finish(new Error("Risposta protocollo non valida"));
        return;
      }

      const expectedBytes = Math.max(1, toNumber(opts.expectedBytes, 1));
      if (received.length >= expectedBytes) {
        finish(null, received.subarray(0, expectedBytes));
      } else {
        finish(new Error("Nessuna risposta ricevuta"));
      }
    });
  });
}

function extractFirstFrame(buffer) {
  for (let i = 0; i <= buffer.length - FRAME_LEN; i += 1) {
    if (buffer[i] !== FRAME_START) {
      continue;
    }
    if (buffer[i + FRAME_LEN - 1] === FRAME_END) {
      return buffer.subarray(i, i + FRAME_LEN);
    }
  }
  return null;
}

function parseFrame(frame) {
  const g = [];
  for (let i = 0; i < 10; i += 1) {
    g.push(frame[3 + i]);
  }
  return {
    start: frame[0],
    address: frame[1],
    command: frame[2],
    g,
    end: frame[13],
    hex: Array.from(frame)
      .map((n) => toHex(n))
      .join(" ")
  };
}

function buildFrame(address, command, gBytes) {
  const b = Buffer.alloc(FRAME_LEN, 0);
  b[0] = FRAME_START;
  b[1] = toAddress(address, 1);
  b[2] = toByte(command, 0x40);

  for (let i = 0; i < 10; i += 1) {
    b[3 + i] = toByte(gBytes[i], 0);
  }

  b[13] = FRAME_END;
  return b;
}

function decodeBits(mask) {
  const out = {};
  for (let i = 1; i <= 8; i += 1) {
    out[String(i)] = (mask & (1 << (i - 1))) !== 0;
  }
  return out;
}

function collectAddresses() {
  const set = new Set();

  for (const b of config.boards) {
    set.add(b.address);
  }
  for (const l of config.entities.lights) {
    set.add(l.address);
  }
  for (const s of config.entities.shutters) {
    set.add(s.address);
  }
  for (const t of config.entities.thermostats) {
    set.add(t.address);
  }

  return Array.from(set).filter((n) => Number.isInteger(n) && n >= 0 && n <= 254);
}

function findLight(id, addressRaw, relayRaw) {
  const byId = (id || "").trim();
  if (byId) {
    return config.entities.lights.find((x) => x.id === byId) || null;
  }

  const address = toAddress(addressRaw, -1);
  const relay = clamp(toNumber(relayRaw, -1), 1, 8);
  if (address < 0 || relay < 1) {
    return null;
  }
  return config.entities.lights.find((x) => x.address === address && x.relay === relay) || null;
}

function findShutter(id, addressRaw, channelRaw) {
  const byId = (id || "").trim();
  if (byId) {
    return config.entities.shutters.find((x) => x.id === byId) || null;
  }

  const address = toAddress(addressRaw, -1);
  const channel = clamp(toNumber(channelRaw, -1), 1, 4);
  if (address < 0 || channel < 1) {
    return null;
  }
  return config.entities.shutters.find((x) => x.address === address && x.channel === channel) || null;
}

function findThermostat(id, addressRaw) {
  const byId = (id || "").trim();
  if (byId) {
    return config.entities.thermostats.find((x) => x.id === byId) || null;
  }

  const address = toAddress(addressRaw, -1);
  if (address < 0) {
    return null;
  }
  return config.entities.thermostats.find((x) => x.address === address) || null;
}

function splitTemperature(v) {
  const rounded = Math.round(v * 10) / 10;
  const i = Math.trunc(Math.abs(rounded));
  const d = Math.round((Math.abs(rounded) - i) * 10);
  return { i: clamp(i, 0, 99), d: clamp(d, 0, 9) };
}

function getRoom(map, name) {
  const key = (name || "Senza stanza").trim() || "Senza stanza";
  if (!map.has(key)) {
    map.set(key, {
      name: key,
      lights: [],
      shutters: [],
      thermostats: [],
      inputs: []
    });
  }
  return map.get(key);
}

function persistStateSoon() {
  if (stateSaveTimer) {
    return;
  }
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    writeJson(STATE_PATH, state);
  }, 200);
}

function tokenValid(token) {
  const expected = String(config.apiToken || "").trim();
  if (!expected) {
    return false;
  }
  return String(token || "") === expected;
}

function truthy(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function normalizeConfig(input) {
  const inCfg = input && typeof input === "object" ? input : {};
  const inGateway = inCfg.gateway && typeof inCfg.gateway === "object" ? inCfg.gateway : {};
  const inEntities = inCfg.entities && typeof inCfg.entities === "object" ? inCfg.entities : {};

  const boardsRaw = Array.isArray(inCfg.boards) ? inCfg.boards : [];

  const boards = boardsRaw.map((board, idx) => {
    const b = board && typeof board === "object" ? board : {};
    const inputsRaw = Array.isArray(b.inputs) ? b.inputs : [];

    const inputs = inputsRaw
      .map((inp, iidx) => {
        const x = inp && typeof inp === "object" ? inp : {};
        return {
          index: clamp(toNumber(x.index, iidx + 1), 1, 8),
          name: safeText(x.name, `Ingresso ${iidx + 1}`),
          room: safeText(x.room, "Senza stanza"),
          enabled: x.enabled !== false,
          g2: toByte(x.g2, 0),
          g3: toByte(x.g3, 0),
          g4: toByte(x.g4, 0),
          targetAddress: toAddress(x.targetAddress, toAddress(b.address, 1))
        };
      })
      .sort((a, b2) => a.index - b2.index);

    return {
      id: safeId(b.id, `board-${idx + 1}`),
      name: safeText(b.name, `Scheda ${idx + 1}`),
      address: toAddress(b.address, idx + 1),
      inputs
    };
  });

  const lights = normalizeArray(inEntities.lights).map((it, idx) => ({
    id: safeId(it.id, `light-${idx + 1}`),
    name: safeText(it.name, `Luce ${idx + 1}`),
    room: safeText(it.room, "Senza stanza"),
    address: toAddress(it.address, 1),
    relay: clamp(toNumber(it.relay, 1), 1, 8)
  }));

  const shutters = normalizeArray(inEntities.shutters).map((it, idx) => ({
    id: safeId(it.id, `shutter-${idx + 1}`),
    name: safeText(it.name, `Tapparella ${idx + 1}`),
    room: safeText(it.room, "Senza stanza"),
    address: toAddress(it.address, 1),
    channel: clamp(toNumber(it.channel, 1), 1, 4)
  }));

  const thermostats = normalizeArray(inEntities.thermostats).map((it, idx) => ({
    id: safeId(it.id, `thermo-${idx + 1}`),
    name: safeText(it.name, `Termostato ${idx + 1}`),
    room: safeText(it.room, "Senza stanza"),
    address: toAddress(it.address, 1),
    setpoint: toFiniteFloat(it.setpoint, 21)
  }));

  return {
    gateway: {
      host: safeText(inGateway.host, "127.0.0.1"),
      port: toPort(inGateway.port, 1470),
      timeoutMs: toTimeout(inGateway.timeoutMs, 1200)
    },
    apiToken: safeText(inCfg.apiToken, DEFAULT_CONFIG.apiToken),
    boards,
    entities: {
      lights,
      shutters,
      thermostats
    }
  };
}

function normalizeState(input) {
  const s = input && typeof input === "object" ? input : {};
  return {
    boards: s.boards && typeof s.boards === "object" ? s.boards : {},
    lights: s.lights && typeof s.lights === "object" ? s.lights : {},
    shutters: s.shutters && typeof s.shutters === "object" ? s.shutters : {},
    thermostats: s.thermostats && typeof s.thermostats === "object" ? s.thermostats : {},
    updatedAt: toNumber(s.updatedAt, 0)
  };
}

function normalizeArray(v) {
  return Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : [];
}

function safeText(v, fallback) {
  const s = String(v === undefined || v === null ? "" : v).trim();
  return s || fallback;
}

function safeId(v, fallback) {
  const raw = safeText(v, fallback).toLowerCase();
  const cleaned = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || fallback;
}

function toNumber(v, fallback) {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (!s) {
      return fallback;
    }
    const parsed = s.startsWith("0x") ? parseInt(s, 16) : Number(s);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function toFiniteFloat(v, fallback) {
  const n = toNumber(v, fallback);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function toByte(v, fallback) {
  return clamp(toNumber(v, fallback), 0, 255);
}

function toAddress(v, fallback) {
  const n = toNumber(v, fallback);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  const t = Math.trunc(n);
  if (t < 0 || t > 254) {
    return fallback;
  }
  return t;
}

function toPort(v, fallback) {
  return clamp(toNumber(v, fallback), 1, 65535);
}

function toTimeout(v, fallback) {
  return clamp(toNumber(v, fallback), 100, 20000);
}

function toHex(v) {
  return `0x${toByte(v, 0).toString(16).padStart(2, "0")}`;
}

function readJson(p, fallback) {
  try {
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw);
  } catch (_err) {
    return fallback;
  }
}

function writeJson(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, p);
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      json(res, 404, { ok: false, error: "File non trovato" });
      return;
    }
    res.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

function redirect(res, where) {
  res.writeHead(302, {
    location: where,
    "cache-control": "no-store"
  });
  res.end();
}

function json(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 512) {
        reject(new Error("Payload troppo grande"));
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve(config);
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_err) {
        reject(new Error("JSON non valido"));
      }
    });
    req.on("error", reject);
  });
}

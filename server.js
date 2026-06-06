const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

// ─── Configuration ───
const PORT = process.env.PORT || 3000;
const PHASES = ['LOBBY', 'CARDS', 'GUESS', 'BLUFF', 'PHOTO'];

// ─── Penalty Options ───
const PENALTIES = [
  '🎤 用三个词描述导师（必须是褒义词！）',
  '😂 说一件你在师门最糗的事',
  '🗣️ 模仿导师说一句经典口头禅',
  '🎵 唱一首歌（哪怕一句也行）',
  '💃 表演一个你的"标志动作"',
  '🤫 爆一个关于在场某人的料',
  '📖 背出导师某篇论文的标题',
  '🎭 用方言介绍你的研究方向',
  '🕺 模仿在场的任意一个人',
  '🤪 做一个大家都没见过的鬼脸',
];

// ─── Game State ───
const state = {
  phase: 'LOBBY',
  roomCode: String(Math.floor(1000 + Math.random() * 9000)),
  players: {},           // { playerId: { name, joinedAt } }
  cards: {},             // { playerId: { gen, fact, event, submittedAt } }
  guessOrder: [],        // [playerId, ...] shuffled, each assigned another's card
  guessAssignments: {},  // { guesserId: cardOwnerId }
  currentGuessIndex: 0,
  guessResults: [],      // [{ guesser, cardOwner, guessedName, correct }]
  // Truth or Dare state
  truthOrder: [],        // [playerId, ...] shuffled order of who gets interrogated
  currentTruthIndex: 0,  // which person is currently being interrogated
};

// ─── SSE Clients ───
const sseClients = new Map();

// ─── Helpers ───
function generateId() {
  return crypto.randomBytes(6).toString('hex');
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getLocalIP() {
  const nets = os.networkInterfaces();
  const candidates = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family !== 'IPv4' || net.internal) continue;
      const ip = net.address;
      if (ip === '0.0.0.0' || ip.startsWith('127.')) continue;
      if (ip.startsWith('169.254.')) continue;
      if (ip.startsWith('2.')) continue;
      if (ip.startsWith('192.168.') || ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
        candidates.unshift(ip);
      } else {
        candidates.push(ip);
      }
    }
  }
  return candidates[0] || 'localhost';
}

function broadcast(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const [id, client] of sseClients) {
    try { client.res.write(`data: ${payload}\n\n`); } catch (e) { sseClients.delete(id); }
  }
}

function broadcastHost(event, data) {
  const payload = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const [id, client] of sseClients) {
    if (client.role === 'host') {
      try { client.res.write(`data: ${payload}\n\n`); } catch (e) { sseClients.delete(id); }
    }
  }
}

function getSafeState() {
  const s = {
    phase: state.phase,
    roomCode: state.roomCode,
    playerCount: Object.keys(state.players).length,
    playerNames: Object.values(state.players).map(p => p.name),
    players: Object.entries(state.players).map(([id, p]) => ({ playerId: id, name: p.name })),
    cardsSubmitted: Object.keys(state.cards).length,
    currentGuessIndex: state.currentGuessIndex,
    guessOrderLength: state.guessOrder.length,
    guessResults: state.guessResults,
    // Truth or Dare info
    truthOrderLength: state.truthOrder.length,
    currentTruthIndex: state.currentTruthIndex,
  };

  if (state.phase === 'GUESS' && state.currentGuessIndex < state.guessOrder.length) {
    const guesserId = state.guessOrder[state.currentGuessIndex];
    const cardOwnerId = state.guessAssignments[guesserId];
    s.currentGuesser = { id: guesserId, name: state.players[guesserId]?.name };
    s.currentCard = state.cards[cardOwnerId] || null;
  }

  // Truth or Dare: include current target player and their card
  if (state.phase === 'BLUFF' && state.currentTruthIndex < state.truthOrder.length) {
    const targetId = state.truthOrder[state.currentTruthIndex];
    s.truthTarget = {
      playerId: targetId,
      name: state.players[targetId]?.name,
      card: state.cards[targetId] || null,
    };
    s.truthDone = state.currentTruthIndex;
    s.truthTotal = state.truthOrder.length;
  }

  return s;
}

// ─── MIME Types ───
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ─── HTTP Server ───
const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('Unhandled request error:', err.message);
    try { res.writeHead(500); res.end('Internal Server Error'); } catch (e) {}
  }
});

function handleRequest(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const route = url.pathname;

  // ─── Static Files ───
  if (route === '/host') {
    serveFile(res, path.join(__dirname, 'public', 'host.html'));
    return;
  }
  if (route === '/' || route === '/index.html') {
    serveFile(res, path.join(__dirname, 'public', 'index.html'));
    return;
  }

  // ─── API: Get State ───
  if (route === '/api/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(getSafeState()));
    return;
  }

  // ─── API: Get Full State (host only) ───
  if (route === '/api/state/full' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ...state,
      playerCount: Object.keys(state.players).length,
    }));
    return;
  }

  // ─── API: Join ───
  if (route === '/api/join' && req.method === 'POST') {
    parseBody(req).then(body => {
      const { name } = body;
      if (!name || !name.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '名字不能为空' }));
        return;
      }
      const trimmed = name.trim();
      const exists = Object.values(state.players).some(p => p.name === trimmed);
      if (exists) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: '这个名字已被使用，换个昵称吧~' }));
        return;
      }
      const playerId = generateId();
      state.players[playerId] = { name: trimmed, joinedAt: Date.now() };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ playerId, name: trimmed, roomCode: state.roomCode }));
      broadcast('player-joined', { playerId, name: trimmed, playerCount: Object.keys(state.players).length });
      broadcastHost('player-list-update', {
        players: Object.fromEntries(
          Object.entries(state.players).map(([id, p]) => [id, p.name])
        ),
      });
    });
    return;
  }

  // ─── API: Rejoin ───
  if (route === '/api/rejoin' && req.method === 'POST') {
    parseBody(req).then(body => {
      const { playerId } = body;
      if (!playerId || !state.players[playerId]) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: '未找到玩家信息，请重新加入' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        playerId,
        name: state.players[playerId].name,
        hasCard: !!state.cards[playerId],
        phase: state.phase,
      }));
    });
    return;
  }

  // ─── API: Submit Card ───
  if (route === '/api/submit-card' && req.method === 'POST') {
    parseBody(req).then(body => {
      const { playerId, gen, fact, event } = body;
      if (!playerId || !state.players[playerId]) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '无效的玩家' }));
        return;
      }
      if (!gen || !fact || !event) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请填写所有三项信息' }));
        return;
      }
      state.cards[playerId] = {
        gen: gen.trim(),
        fact: fact.trim(),
        event: event.trim(),
        submittedAt: Date.now(),
      };
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
      broadcastHost('card-submitted', {
        playerId,
        name: state.players[playerId].name,
        cardsSubmitted: Object.keys(state.cards).length,
        totalPlayers: Object.keys(state.players).length,
      });
    });
    return;
  }

  // ─── API: Advance Phase ───
  if (route === '/api/advance-phase' && req.method === 'POST') {
    parseBody(req).then(body => {
      const { direction } = body;
      const currentIdx = PHASES.indexOf(state.phase);

      if (direction === 'next') {
        const nextIdx = currentIdx + 1;
        if (nextIdx >= PHASES.length) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: '已经是最后一个阶段' }));
          return;
        }
        const nextPhase = PHASES[nextIdx];

        if (nextPhase === 'GUESS') {
          const playerIds = Object.keys(state.cards);
          if (playerIds.length < 2) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: '至少需要2人提交卡片才能开始竞猜' }));
            return;
          }
          let assigned;
          do {
            assigned = shuffle(playerIds);
          } while (assigned.some((id, i) => id === playerIds[i]) && playerIds.length > 1);
          state.guessOrder = shuffle([...playerIds]);
          state.guessAssignments = {};
          playerIds.forEach((id, i) => { state.guessAssignments[id] = assigned[i]; });
          state.currentGuessIndex = 0;
          state.guessResults = [];
        }

        if (nextPhase === 'BLUFF') {
          const cardPlayers = Object.keys(state.cards);
          state.truthOrder = shuffle([...cardPlayers]);
          state.currentTruthIndex = 0;
          if (cardPlayers.length === 0) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: '没有卡片可以展示' }));
            return;
          }
        }

        state.phase = nextPhase;
        broadcast('phase-changed', { phase: nextPhase });

        if (nextPhase === 'BLUFF') {
          broadcastTruthUpdate();
        }

        if (nextPhase === 'GUESS') {
          broadcastHost('guess-setup', {
            guessOrder: state.guessOrder.map(id => ({
              playerId: id, name: state.players[id].name,
            })),
            currentGuesser: {
              id: state.guessOrder[0],
              name: state.players[state.guessOrder[0]].name,
            },
            currentCard: state.cards[state.guessAssignments[state.guessOrder[0]]],
          });
        }
      } else if (direction === 'prev') {
        const prevIdx = currentIdx - 1;
        if (prevIdx < 0) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: '已经是第一个阶段' }));
          return;
        }
        state.phase = PHASES[prevIdx];
        broadcast('phase-changed', { phase: PHASES[prevIdx] });
      }

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true, phase: state.phase }));
    });
    return;
  }

  // ─── API: Next Guesser ───
  if (route === '/api/next-guesser' && req.method === 'POST') {
    state.currentGuessIndex++;
    if (state.currentGuessIndex >= state.guessOrder.length) {
      broadcast('guess-phase-done', { results: state.guessResults });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ done: true }));
      return;
    }
    const guesserId = state.guessOrder[state.currentGuessIndex];
    const cardOwnerId = state.guessAssignments[guesserId];
    broadcastHost('next-guesser', {
      currentGuesser: { id: guesserId, name: state.players[guesserId].name },
      currentCard: state.cards[cardOwnerId],
      index: state.currentGuessIndex,
      total: state.guessOrder.length,
    });
    broadcast('guess-turn-update', {
      index: state.currentGuessIndex, total: state.guessOrder.length,
    });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ─── API: Submit Guess ───
  if (route === '/api/guess' && req.method === 'POST') {
    parseBody(req).then(body => {
      const { playerId, guessedPlayerId } = body;
      if (!playerId || !guessedPlayerId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: '请选择你要猜的人' }));
        return;
      }
      if (playerId !== state.guessOrder[state.currentGuessIndex]) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: '还没轮到你猜' }));
        return;
      }
      const cardOwnerId = state.guessAssignments[playerId];
      const correct = guessedPlayerId === cardOwnerId;
      const penalty = correct ? null : PENALTIES[Math.floor(Math.random() * PENALTIES.length)];

      state.guessResults.push({
        guesser: playerId,
        guesserName: state.players[playerId].name,
        cardOwner: cardOwnerId,
        cardOwnerName: state.players[cardOwnerId].name,
        guessedName: state.players[guessedPlayerId]?.name || '未知',
        correct,
      });

      broadcastHost('guess-result', {
        guesser: playerId, guesserName: state.players[playerId].name,
        correct, cardOwner: cardOwnerId, cardOwnerName: state.players[cardOwnerId].name,
        card: state.cards[cardOwnerId], penalty,
      });
      broadcast('guess-result-public', {
        guesserName: state.players[playerId].name,
        correct, cardOwnerName: state.players[cardOwnerId].name,
      });

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ correct, cardOwnerName: state.players[cardOwnerId].name, penalty }));
    });
    return;
  }

  // ═══════════════════════════════════════
  //  Truth or Dare (真心话大冒险) APIs
  // ═══════════════════════════════════════

  // ─── Next Truth Target (host clicks "下一位") ───
  if (route === '/api/next-truth' && req.method === 'POST') {
    if (state.phase !== 'BLUFF') {
      res.writeHead(400);
      res.end(JSON.stringify({ error: '不在真心话大冒险阶段' }));
      return;
    }
    state.currentTruthIndex++;
    if (state.currentTruthIndex >= state.truthOrder.length) {
      broadcast('truth-phase-done', {});
      broadcastHost('truth-phase-done', {});
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ done: true }));
      return;
    }
    broadcastTruthUpdate();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ─── Get Random Penalty ───
  if (route === '/api/random-penalty' && req.method === 'GET') {
    const penalty = PENALTIES[Math.floor(Math.random() * PENALTIES.length)];
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ penalty }));
    return;
  }

  // ─── API: Reset Game ───
  if (route === '/api/reset' && req.method === 'POST') {
    state.phase = 'LOBBY';
    state.players = {};
    state.cards = {};
    state.guessOrder = [];
    state.guessAssignments = {};
    state.currentGuessIndex = 0;
    state.guessResults = [];
    state.truthOrder = [];
    state.currentTruthIndex = 0;
    state.roomCode = String(Math.floor(1000 + Math.random() * 9000));
    broadcast('game-reset', { roomCode: state.roomCode });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // ─── SSE Event Stream ───
  if (route === '/events') {
    const clientId = generateId();
    const role = url.searchParams.get('role') || 'player';
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const initialState = role === 'host'
      ? { ...state, playerCount: Object.keys(state.players).length }
      : getSafeState();
    res.write(`data: ${JSON.stringify({ event: 'init', data: initialState, timestamp: Date.now() })}\n\n`);
    sseClients.set(clientId, { req, res, role });
    const heartbeat = setInterval(() => {
      try { res.write(`:ping\n\n`); }
      catch (e) { clearInterval(heartbeat); sseClients.delete(clientId); }
    }, 15000);
    req.on('close', () => { clearInterval(heartbeat); sseClients.delete(clientId); });
    return;
  }

  // ─── API: Get Public URL ───
  if (route === '/api/public-url' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ url: publicUrl, localIP: getLocalIP(), roomCode: state.roomCode }));
    return;
  }

  // ─── 404 ───
  res.writeHead(404);
  res.end('Not Found');
}

// ─── Global error handlers ───
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err.message);
  // Don't crash - log and continue
});

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
  // Don't crash - log and continue
});

// ─── Truth or Dare Helpers ───
function broadcastTruthUpdate() {
  if (state.currentTruthIndex >= state.truthOrder.length) return;
  const targetId = state.truthOrder[state.currentTruthIndex];
  const data = {
    target: {
      playerId: targetId,
      name: state.players[targetId]?.name || '?',
      card: state.cards[targetId] || null,
    },
    index: state.currentTruthIndex,
    total: state.truthOrder.length,
    remaining: state.truthOrder.length - state.currentTruthIndex - 1,
  };
  broadcast('truth-target', data);
  broadcastHost('truth-target', data);
}

// ─── Body Parser ───
function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch (e) { resolve({}); }
    });
    req.on('error', () => { resolve({}); });
  });
}

// ─── File Server ───
function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('File not found');
  }
}

// ─── Public URL (set by auto-tunnel) ───
let publicUrl = null;

// ─── Start ───
const { spawn } = require('child_process');
const argIP = process.argv.find(a => a.startsWith('--ip='));
const localIP = argIP ? argIP.split('=')[1] : getLocalIP();
const noTunnel = process.argv.includes('--no-tunnel');

if (process.platform === 'win32') {
  try {
    const { execSync } = require('child_process');
    execSync(`netsh advfirewall firewall add rule name="贾门Icebreaker" dir=in action=allow protocol=TCP localport=${PORT}`, { stdio: 'ignore', timeout: 5000 });
    execSync(`netsh advfirewall firewall add rule name="贾门Icebreaker-Node" dir=in action=allow program="${process.execPath}"`, { stdio: 'ignore', timeout: 5000 });
  } catch (e) {}
}

function startTunnel() {
  if (noTunnel) return;
  console.log('🌐 正在建立公网隧道...');
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ConnectTimeout=15',
    '-R', '80:localhost:' + PORT,
    'serveo.net'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let buffer = '';
  ssh.stderr.on('data', (chunk) => {
    buffer += chunk.toString();
    const match = buffer.match(/https:\/\/[^\s]+\.serveousercontent\.com/);
    if (match && !publicUrl) {
      publicUrl = match[0];
      console.log('🔗 公网地址：' + publicUrl);
      console.log('   主持人：' + publicUrl + '/host');
      console.log('');
    }
    // Keep buffer from growing too large
    if (buffer.length > 5000) buffer = buffer.slice(-2000);
  });

  ssh.on('close', () => {
    if (publicUrl) {
      console.log('⚠️  公网隧道断开，正在重连...');
      publicUrl = null;
    }
    setTimeout(startTunnel, 3000);
  });

  ssh.on('error', () => {
    setTimeout(startTunnel, 5000);
  });
}

server.listen(PORT, () => {
  console.log('');
  console.log('🎬 ╔══════════════════════════════════════╗');
  console.log('   ║   贾门专属 Icebreaker                ║');
  console.log('   ╚══════════════════════════════════════╝');
  console.log('');
  console.log('✅ 服务器已启动（端口 ' + PORT + '）');
  console.log('📍 局域网IP：' + localIP);
  console.log('🔑 房间码：' + state.roomCode);
  if (localIP === 'localhost') {
    console.log('⚠️  未检测到局域网IP，同门可能无法直连');
  }
  console.log('');
  if (!process.env.RENDER) startTunnel();
});

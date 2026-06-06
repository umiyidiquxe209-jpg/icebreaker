const crypto = require('crypto');

// ─── Configuration ───
const PHASES = ['LOBBY', 'CARDS', 'GUESS', 'BLUFF', 'PHOTO'];

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

// ─── In-memory state (persists across warm invocations) ───
let gameState = createInitialState();

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

function createInitialState() {
  return {
    phase: 'LOBBY',
    roomCode: String(Math.floor(1000 + Math.random() * 9000)),
    players: {},
    cards: {},
    guessOrder: [],
    guessAssignments: {},
    currentGuessIndex: 0,
    guessResults: [],
    truthOrder: [],
    currentTruthIndex: 0,
    version: 0,
  };
}

function getSafeState(state) {
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
    truthOrderLength: state.truthOrder.length,
    currentTruthIndex: state.currentTruthIndex,
    version: state.version,
  };

  if (state.phase === 'GUESS' && state.currentGuessIndex < state.guessOrder.length) {
    const guesserId = state.guessOrder[state.currentGuessIndex];
    const cardOwnerId = state.guessAssignments[guesserId];
    s.currentGuesser = { id: guesserId, name: state.players[guesserId]?.name };
    s.currentCard = state.cards[cardOwnerId] || null;
  }

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

// ─── CORS ───
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(body, status = 200) {
  return { statusCode: status, headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) };
}

// ─── State helpers ───
function loadState() {
  return gameState;
}

function saveState() {
  gameState.version = (gameState.version || 0) + 1;
}

// ─── Route parser ───
function getRoute(path) {
  const idx = path.indexOf('/api/');
  if (idx === -1) return '/';
  return '/' + path.substring(idx + 5);
}

// ─── Main Handler ───
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders };
  }

  const route = getRoute(event.path);
  const method = event.httpMethod;

  try {
    // ─── GET Routes ───
    if (route === '/state' && method === 'GET') {
      return json(getSafeState(loadState()));
    }

    if (route === '/state/full' && method === 'GET') {
      const state = loadState();
      return json({ ...state, playerCount: Object.keys(state.players).length });
    }

    if (route === '/random-penalty' && method === 'GET') {
      return json({ penalty: PENALTIES[Math.floor(Math.random() * PENALTIES.length)] });
    }

    // ─── POST Routes ───
    const body = event.body ? JSON.parse(event.body) : {};
    const state = loadState();

    // ─── Join ───
    if (route === '/join' && method === 'POST') {
      const { name } = body;
      if (!name || !name.trim()) return json({ error: '名字不能为空' }, 400);
      const trimmed = name.trim();
      const exists = Object.values(state.players).some(p => p.name === trimmed);
      if (exists) return json({ error: '这个名字已被使用，换个昵称吧~' }, 409);
      const playerId = generateId();
      state.players[playerId] = { name: trimmed, joinedAt: Date.now() };
      saveState();
      return json({ playerId, name: trimmed, roomCode: state.roomCode });
    }

    // ─── Rejoin ───
    if (route === '/rejoin' && method === 'POST') {
      const { playerId } = body;
      if (!playerId || !state.players[playerId]) {
        return json({ error: '未找到玩家信息，请重新加入' }, 404);
      }
      return json({
        playerId,
        name: state.players[playerId].name,
        hasCard: !!state.cards[playerId],
        phase: state.phase,
      });
    }

    // ─── Submit Card ───
    if (route === '/submit-card' && method === 'POST') {
      const { playerId, gen, fact, event } = body;
      if (!playerId || !state.players[playerId]) return json({ error: '无效的玩家' }, 400);
      if (!gen || !fact || !event) return json({ error: '请填写所有三项信息' }, 400);
      state.cards[playerId] = {
        gen: gen.trim(),
        fact: fact.trim(),
        event: event.trim(),
        submittedAt: Date.now(),
      };
      saveState();
      return json({ success: true });
    }

    // ─── Advance Phase ───
    if (route === '/advance-phase' && method === 'POST') {
      const { direction } = body;
      const currentIdx = PHASES.indexOf(state.phase);

      if (direction === 'next') {
        const nextIdx = currentIdx + 1;
        if (nextIdx >= PHASES.length) return json({ error: '已经是最后一个阶段' }, 400);
        const nextPhase = PHASES[nextIdx];

        if (nextPhase === 'GUESS') {
          const playerIds = Object.keys(state.cards);
          if (playerIds.length < 2) return json({ error: '至少需要2人提交卡片才能开始竞猜' }, 400);
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
          if (cardPlayers.length === 0) return json({ error: '没有卡片可以展示' }, 400);
        }

        state.phase = nextPhase;
        saveState();
      } else if (direction === 'prev') {
        const prevIdx = currentIdx - 1;
        if (prevIdx < 0) return json({ error: '已经是第一个阶段' }, 400);
        state.phase = PHASES[prevIdx];
        saveState();
      }

      return json({ success: true, phase: state.phase });
    }

    // ─── Next Guesser ───
    if (route === '/next-guesser' && method === 'POST') {
      state.currentGuessIndex++;
      if (state.currentGuessIndex >= state.guessOrder.length) {
        saveState();
        return json({ done: true });
      }
      saveState();
      return json({ success: true });
    }

    // ─── Submit Guess ───
    if (route === '/guess' && method === 'POST') {
      const { playerId, guessedPlayerId } = body;
      if (!playerId || !guessedPlayerId) return json({ error: '请选择你要猜的人' }, 400);
      if (playerId !== state.guessOrder[state.currentGuessIndex]) {
        return json({ error: '还没轮到你猜' }, 403);
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

      saveState();
      return json({
        correct,
        cardOwnerName: state.players[cardOwnerId].name,
        penalty,
        card: state.cards[cardOwnerId],
      });
    }

    // ─── Next Truth ───
    if (route === '/next-truth' && method === 'POST') {
      if (state.phase !== 'BLUFF') return json({ error: '不在真心话大冒险阶段' }, 400);
      state.currentTruthIndex++;
      if (state.currentTruthIndex >= state.truthOrder.length) {
        saveState();
        return json({ done: true });
      }
      saveState();
      return json({ success: true });
    }

    // ─── Reset ───
    if (route === '/reset' && method === 'POST') {
      gameState = createInitialState();
      return json({ success: true });
    }

    return json({ error: 'Not Found' }, 404);
  } catch (err) {
    console.error('API Error:', err.message);
    return json({ error: '服务器内部错误: ' + err.message }, 500);
  }
};

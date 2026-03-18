const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

app.use(cors());
app.use(express.json());

// ══════════════════════════════════════════
//  상수
// ══════════════════════════════════════════
const INITIAL_CASH_WHALE = 200_000_000;
const INITIAL_CASH_ANT   = 100_000_000;
const BOT_TICK_MS  = 2000;  // 봇 시세 변동 주기
const PRICE_BROADCAST_MS = 1000; // 가격 브로드캐스트 주기

const STOCK_DEFS = [
  { ticker: 'MOONX', name: '문엑스코퍼', basePrice: 75000,  vol: 0.022, sector: '우주' },
  { ticker: 'DOGE3', name: '도지쓰리',   basePrice: 52000,  vol: 0.035, sector: '밈코인' },
  { ticker: 'ZZANG', name: '짱테크',     basePrice: 135000, vol: 0.028, sector: 'AI' },
];

const EVENT_DEFS = [
  { id: 'fed_rate',   icon: '🏦', title: '연준 금리 인상',    desc: '전 종목 -5%~-10% 충격',          type: 'down', power: -0.07 },
  { id: 'chip_boom',  icon: '💾', title: '반도체 슈퍼사이클', desc: '반도체 종목 +10%~+20% 급등',      type: 'up',   power: 0.15, sector: '반도체' },
  { id: 'korea_war',  icon: '💣', title: '지정학적 긴장',     desc: '전 종목 급락, -10%~-20%',         type: 'down', power: -0.15 },
  { id: 'ai_boom',    icon: '🤖', title: 'AI 붐 발표',        desc: '플랫폼/반도체 +15% 상승',         type: 'up',   power: 0.15, sector: '플랫폼' },
  { id: 'scandal',    icon: '🚨', title: '회계 부정 의혹',    desc: '무작위 종목 -20% 폭락',           type: 'down', power: -0.20, random: true },
  { id: 'listing',    icon: '🎉', title: '외국인 대량 매수',  desc: '무작위 종목 +20% 급등',           type: 'up',   power: 0.20, random: true },
];

const INSIDER_TEMPLATES = [
  (t, d) => `🔍 ${t} ${d > 0 ? '상승' : '하락'} 예정. 미리 포지션 잡을 것.`,
  (t, d) => `📨 기관 투자자가 ${t} 대량 ${d > 0 ? '매집' : '매도'} 중.`,
  (t, d) => `⚠️ ${t} 다음 이벤트 ${d > 0 ? '호재' : '악재'} 예정.`,
  (t, d) => `🕵️ 내부 소식: ${t} 곧 ${d > 0 ? '+10~20%' : '-10~20%'} 움직임 예상.`,
];

// ══════════════════════════════════════════
//  인메모리 세션 저장소
//  sessions[code] = { ...게임 상태 }
// ══════════════════════════════════════════
const sessions = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

function initPrices() {
  return STOCK_DEFS.map(s => ({
    ticker:    s.ticker,
    name:      s.name,
    sector:    s.sector,
    price:     s.basePrice,
    basePrice: s.basePrice,
    history:   [s.basePrice],
    candles:   [],
    _open:     s.basePrice,
    _high:     s.basePrice,
    _low:      s.basePrice,
  }));
}

function createSession(whaleName, durationSec) {
  let code;
  do { code = genCode(); } while (sessions[code]);

  sessions[code] = {
    code,
    whaleName,
    durationSec,
    timeLeft:  durationSec,
    started:   false,
    ended:     false,
    prices:    initPrices(),
    players:   {},          // name -> playerObj
    news:      [],
    usedEvents: new Set(),
    botTimer:  null,
    countdown: null,
    insiderTimer: null,
  };
  return code;
}

function addPlayer(code, name, role) {
  const s = sessions[code];
  if (!s) return null;
  if (s.players[name]) return null; // 중복
  const initCash = role === 'whale' ? INITIAL_CASH_WHALE : INITIAL_CASH_ANT;
  s.players[name] = {
    name, role,
    cash: initCash,
    initCash,
    portfolio: {},  // ticker -> { qty, avgPrice }
  };
  return s.players[name];
}

function playerTotal(session, name) {
  const p = session.players[name];
  if (!p) return 0;
  let total = p.cash;
  for (const [ticker, pos] of Object.entries(p.portfolio)) {
    const stock = session.prices.find(s => s.ticker === ticker);
    if (stock) total += stock.price * pos.qty;
  }
  return total;
}

function getRanking(session) {
  return Object.values(session.players)
    .map(p => ({
      name:  p.name,
      role:  p.role,
      total: playerTotal(session, p.name),
    }))
    .sort((a, b) => b.total - a.total);
}

function pushNews(session, text, type) {
  const now = new Date();
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map(n => String(n).padStart(2, '0')).join(':');
  const item = { text, type, time };
  session.news.unshift(item);
  if (session.news.length > 30) session.news.pop();
  io.to(session.code).emit('news', item);
}

// ── 봇 틱 (5틱마다 캔들 1개 생성) ──
const CANDLE_TICKS = 5;
const tickCounters = {};

function botTick(session) {
  if (session.ended) return;
  if (!tickCounters[session.code]) tickCounters[session.code] = 0;
  tickCounters[session.code]++;
  const isCandle = tickCounters[session.code] % CANDLE_TICKS === 0;

  session.prices.forEach(p => {
    const def = STOCK_DEFS.find(d => d.ticker === p.ticker);
    const drift = (Math.random() - 0.48) * def.vol;
    const newPrice = Math.max(1000, Math.round(p.price * (1 + drift)));

    p._high = Math.max(p._high || newPrice, newPrice);
    p._low  = Math.min(p._low  || newPrice, newPrice);
    p.price = newPrice;

    if (isCandle) {
      const candle = { o: p._open, h: p._high, l: p._low, c: newPrice };
      p.candles.push(candle);
      if (p.candles.length > 60) p.candles.shift();
      p._open = newPrice;
      p._high = newPrice;
      p._low  = newPrice;
    }

    p.history.push(newPrice);
    if (p.history.length > 120) p.history.shift();
  });
}

// ── 게임 시작 ──
function startSession(code) {
  const s = sessions[code];
  if (!s || s.started) return;
  s.started = true;

  // 봇 타이머
  s.botTimer = setInterval(() => {
    botTick(s);
    io.to(code).emit('prices', s.prices);
    io.to(code).emit('ranking', getRanking(s));
  }, BOT_TICK_MS);

  // 카운트다운
  s.countdown = setInterval(() => {
    s.timeLeft = Math.max(0, s.timeLeft - 1);
    io.to(code).emit('timer', s.timeLeft);
    if (s.timeLeft <= 0) endSession(code);
  }, 1000);

  // 내부 정보 (고래에게만)
  s.insiderTimer = setInterval(() => {
    const whaleSocket = findWhaleSocket(code);
    if (whaleSocket) {
      const i = Math.floor(Math.random() * STOCK_DEFS.length);
      const dir = Math.random() > 0.5 ? 1 : -1;
      const tpl = INSIDER_TEMPLATES[Math.floor(Math.random() * INSIDER_TEMPLATES.length)];
      whaleSocket.emit('insider', tpl(STOCK_DEFS[i].ticker, dir));
    }
  }, 15000);

  io.to(code).emit('gameStarted');
  pushNews(s, '🔔 게임이 시작됐습니다!', 'event');
}

function findWhaleSocket(code) {
  const s = sessions[code];
  if (!s) return null;
  for (const [, socket] of io.sockets.sockets) {
    if (socket.sessionCode === code && socket.playerName === s.whaleName) return socket;
  }
  return null;
}

function endSession(code) {
  const s = sessions[code];
  if (!s || s.ended) return;
  s.ended = true;
  clearInterval(s.botTimer);
  clearInterval(s.countdown);
  clearInterval(s.insiderTimer);
  const ranking = getRanking(s);
  io.to(code).emit('gameEnded', ranking);
  pushNews(s, '🏁 게임 종료!', 'event');
  // 1시간 후 세션 정리
  setTimeout(() => delete sessions[code], 3600_000);
}

// ══════════════════════════════════════════
//  REST — 헬스체크
// ══════════════════════════════════════════
app.get('/health', (_, res) => res.json({ ok: true }));

// ══════════════════════════════════════════
//  Socket.io
// ══════════════════════════════════════════
io.on('connection', socket => {
  console.log(`[+] connected: ${socket.id}`);

  // ── 세션 만들기 (고래) ──
  socket.on('createSession', ({ whaleName, durationMin }, cb) => {
    const code = createSession(whaleName, durationMin * 60);
    const player = addPlayer(code, whaleName, 'whale');
    socket.join(code);
    socket.sessionCode  = code;
    socket.playerName   = whaleName;
    socket.playerRole   = 'whale';
    console.log(`[session] created ${code} by ${whaleName}`);
    cb({ ok: true, code, player, stocks: STOCK_DEFS, events: EVENT_DEFS });
  });

  // ── 세션 참가 (개미) ──
  socket.on('joinSession', ({ code, name }, cb) => {
    const s = sessions[code];
    if (!s) return cb({ ok: false, error: '세션을 찾을 수 없습니다.' });
    if (s.ended) return cb({ ok: false, error: '이미 종료된 게임입니다.' });
    if (s.players[name]) return cb({ ok: false, error: '이미 사용 중인 닉네임입니다.' });

    const player = addPlayer(code, name, 'ant');
    socket.join(code);
    socket.sessionCode = code;
    socket.playerName  = name;
    socket.playerRole  = 'ant';

    // 현재 상태 전달
    cb({
      ok: true,
      player,
      prices: s.prices,
      started: s.started,
      timeLeft: s.timeLeft,
      stocks: STOCK_DEFS,
      events: EVENT_DEFS,
      news: s.news.slice(0, 10),
    });

    // 방 안에 새 참가자 알림
    socket.to(code).emit('playerJoined', { name, role: 'ant' });
    io.to(code).emit('ranking', getRanking(s));
    pushNews(s, `🐜 ${name}이(가) 참가했습니다!`, 'ant');
    console.log(`[join] ${name} -> ${code}`);
  });

  // ── 게임 시작 (고래만) ──
  socket.on('startGame', (_, cb) => {
    const code = socket.sessionCode;
    const s = sessions[code];
    if (!s || socket.playerRole !== 'whale') return cb?.({ ok: false });
    startSession(code);
    cb?.({ ok: true });
  });

  // ── 매수/매도 ──
  socket.on('trade', ({ ticker, qty, mode }, cb) => {
    const code = socket.sessionCode;
    const name = socket.playerName;
    const s = sessions[code];
    if (!s || !s.started || s.ended) return cb({ ok: false, error: '거래 불가 상태' });

    const p = s.players[name];
    if (!p) return cb({ ok: false, error: '플레이어 없음' });

    const stock = s.prices.find(st => st.ticker === ticker);
    if (!stock) return cb({ ok: false, error: '종목 없음' });

    const price = stock.price;
    const total = price * qty;

    if (mode === 'buy') {
      if (total > p.cash) return cb({ ok: false, error: '잔액 부족' });
      p.cash -= total;
      if (!p.portfolio[ticker]) p.portfolio[ticker] = { qty: 0, avgPrice: 0 };
      const pos = p.portfolio[ticker];
      pos.avgPrice = (pos.avgPrice * pos.qty + price * qty) / (pos.qty + qty);
      pos.qty += qty;
    } else {
      const pos = p.portfolio[ticker];
      if (!pos || pos.qty < qty) return cb({ ok: false, error: '보유 수량 부족' });
      p.cash += price * qty;
      pos.qty -= qty;
      if (pos.qty === 0) delete p.portfolio[ticker];
    }

    cb({ ok: true, cash: p.cash, portfolio: p.portfolio });
    io.to(code).emit('ranking', getRanking(s));
    const emoji = mode === 'buy' ? '📈' : '📉';
    pushNews(s, `${emoji} ${name}이(가) ${ticker} ${qty}주 ${mode === 'buy' ? '매수' : '매도'}`, mode === 'buy' ? 'up' : 'down');

    // 고래 거래면 전체에 별도 브로드캐스트
    if (p.role === 'whale') {
      const now = new Date();
      const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2,'0')).join(':');
      io.to(code).emit('whaleTrade', { ticker, qty, mode, price, time });
    }
  });

  // ── 시세 조종 (고래만) ──
  socket.on('manipulate', ({ ticker, dir }, cb) => {
    if (socket.playerRole !== 'whale') return cb?.({ ok: false });
    const code = socket.sessionCode;
    const s = sessions[code];
    if (!s || s.ended) return cb?.({ ok: false });

    const stock = s.prices.find(st => st.ticker === ticker);
    if (!stock) return cb?.({ ok: false });

    const factor = dir === 'up'
      ? 1 + 0.05 + Math.random() * 0.05
      : 1 - 0.05 - Math.random() * 0.05;
    stock.price = Math.max(1000, Math.round(stock.price * factor));
    stock.history.push(stock.price);

    io.to(code).emit('prices', s.prices);
    const label = dir === 'up' ? '📈 펌핑' : '📉 덤핑';
    pushNews(s, `🐋 고래가 ${ticker} ${label} 실행!`, 'whale');
    cb?.({ ok: true });
  });

  // ── 이벤트 카드 (고래만) ──
  socket.on('triggerEvent', ({ eventId }, cb) => {
    if (socket.playerRole !== 'whale') return cb?.({ ok: false });
    const code = socket.sessionCode;
    const s = sessions[code];
    if (!s || s.ended) return cb?.({ ok: false });
    if (s.usedEvents.has(eventId)) return cb?.({ ok: false, error: '이미 사용한 카드' });

    const ev = EVENT_DEFS.find(e => e.id === eventId);
    if (!ev) return cb?.({ ok: false });

    s.usedEvents.add(eventId);

    s.prices.forEach(stock => {
      let apply = false;
      if (ev.sector)  apply = stock.sector === ev.sector;
      else if (ev.random) apply = Math.random() < 0.5;
      else            apply = true;

      if (apply) {
        const factor = 1 + ev.power + (Math.random() - 0.5) * Math.abs(ev.power) * 0.5;
        stock.price = Math.max(1000, Math.round(stock.price * factor));
        stock.history.push(stock.price);
      }
    });

    io.to(code).emit('prices', s.prices);
    io.to(code).emit('eventTriggered', ev);
    pushNews(s, `⚡ 이벤트 발생: ${ev.title}!`, 'event');
    cb?.({ ok: true });
  });

  // ── 참가자 목록 요청 ──
  socket.on('getPlayers', (_, cb) => {
    const s = sessions[socket.sessionCode];
    if (!s) return cb?.([]);
    cb?.(Object.values(s.players).map(p => ({ name: p.name, role: p.role })));
  });

  // ── 연결 해제 ──
  socket.on('disconnect', () => {
    console.log(`[-] disconnected: ${socket.id}`);
    const code = socket.sessionCode;
    const s = sessions[code];
    if (s && socket.playerName) {
      io.to(code).emit('ranking', getRanking(s));
    }
  });
});

// ══════════════════════════════════════════
//  서버 시작
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Stock Game Server running on port ${PORT}`));

const db = require('../config/db');

// roomState[code] = { hostSocketId, members: Map<socketId, {userId, username}>, readySet: Set, currentTrackId, countdownActive }
const roomState = {};

function getState(code) {
  if (!roomState[code]) {
    roomState[code] = { hostSocketId: null, members: new Map(), readySet: new Set(), currentTrackId: null, countdownActive: false };
  }
  return roomState[code];
}

function startCountdown(io, code, trackId) {
  const s = getState(code);
  if (s.countdownActive) return;
  s.countdownActive = true;
  let n = 3;
  const iv = setInterval(() => {
    io.to(code).emit('sync-countdown', { secondsLeft: n });
    n--;
    if (n < 0) {
      clearInterval(iv);
      s.countdownActive = false;
      io.to(code).emit('start-playback', { trackId, startTime: Date.now() + 500 });
    }
  }, 1000);
}

module.exports = function initSocket(io) {
  io.on('connection', (socket) => {

    // join-room
    socket.on('join-room', async ({ roomCode, userId, username }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      try {
        const [rows] = await db.query('SELECT * FROM rooms WHERE code = ? AND is_active = TRUE', [code]);
        if (!rows.length) { socket.emit('room-joined', { success: false, message: 'Room not found' }); return; }

        socket.join(code);
        socket.data = { roomCode: code, userId, username };

        const s = getState(code);
        s.members.set(socket.id, { userId, username });
        if (rows[0].created_by === parseInt(userId)) s.hostSocketId = socket.id;

        socket.emit('room-joined', { success: true, listenerCount: s.members.size });
        socket.to(code).emit('listener-joined', { listenerCount: s.members.size, username });
      } catch (e) { console.error('join-room', e); }
    });

    // get-queue — send existing tracks when someone joins
    socket.on('get-queue', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      try {
        const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [code]);
        if (!rooms.length) return;
        const [tracks] = await db.query(
          'SELECT id as trackId, track_name as trackName, added_by as addedBy, file_url as fileUrl FROM queue WHERE room_id = ? ORDER BY order_index ASC',
          [rooms[0].id]
        );
        socket.emit('queue-state', { tracks });
      } catch (e) { console.error('get-queue', e); }
    });

    // track-uploaded — broadcast new track to room
    socket.on('track-uploaded', ({ roomCode, trackId, fileUrl, trackName, addedBy }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const s = getState(code);
      s.currentTrackId = trackId;
      s.readySet.clear();
      s.countdownActive = false;
      io.to(code).emit('track-available', { trackId, fileUrl, trackName, addedBy });
    });

    // device-ready — when all devices ready, start countdown
    socket.on('device-ready', ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const s = getState(code);
      s.readySet.add(socket.id);
      if (s.readySet.size >= s.members.size && s.members.size > 0 && !s.countdownActive) {
        startCountdown(io, code, s.currentTrackId);
      }
    });

    // track-ended — play next
    socket.on('track-ended', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      try {
        const s = getState(code);
        if (s.currentTrackId) {
          await db.query('UPDATE queue SET is_played = TRUE WHERE id = ?', [s.currentTrackId]);
        }
        const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [code]);
        if (!rooms.length) return;
        const [next] = await db.query(
          'SELECT id, track_name, added_by, file_url FROM queue WHERE room_id = ? AND is_played = FALSE ORDER BY order_index ASC LIMIT 1',
          [rooms[0].id]
        );
        if (next.length) {
          s.currentTrackId = next[0].id;
          s.readySet.clear();
          s.countdownActive = false;
          io.to(code).emit('track-available', { trackId: next[0].id, fileUrl: next[0].file_url, trackName: next[0].track_name, addedBy: next[0].added_by });
        }
      } catch (e) { console.error('track-ended', e); }
    });

    // playback controls
    socket.on('pause-track',  ({ roomCode, position }) => socket.to(roomCode?.toUpperCase()).emit('playback-paused',  { position }));
    socket.on('resume-track', ({ roomCode, position }) => socket.to(roomCode?.toUpperCase()).emit('playback-resumed', { position }));
    socket.on('seek-track',   ({ roomCode, position }) => socket.to(roomCode?.toUpperCase()).emit('playback-seeked',  { position }));

    // leave / disconnect
    socket.on('leave-room', ({ roomCode }) => handleLeave(io, socket, roomCode?.toUpperCase()));
    socket.on('disconnect', () => { if (socket.data?.roomCode) handleLeave(io, socket, socket.data.roomCode); });
  });
};

async function handleLeave(io, socket, code) {
  if (!code || !roomState[code]) return;
  const s = roomState[code];
  const member = s.members.get(socket.id);
  s.members.delete(socket.id);
  s.readySet.delete(socket.id);
  socket.leave(code);

  if (s.hostSocketId === socket.id) {
    try { await db.query('UPDATE rooms SET is_active = FALSE WHERE code = ?', [code]); } catch {}
    io.to(code).emit('host-left', { message: 'Host left. Room closed.' });
    delete roomState[code];
  } else {
    io.to(code).emit('listener-left', { listenerCount: s.members.size, username: member?.username });
  }
}

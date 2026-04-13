const db = require('../config/db');

// roomState[code] = {
//   hostSocketId:   string | null,
//   members:        Map<socketId, { userId, username }>,
//   readySet:       Set<socketId>,          // for initial autoplay only
//   currentTrackId: number | null,
//   countdownActive: boolean                // kept for device-ready autoplay path
// }
const roomState = {};

function getState(code) {
  if (!roomState[code]) {
    roomState[code] = {
      hostSocketId:    null,
      members:         new Map(),
      readySet:        new Set(),
      currentTrackId:  null,
      countdownActive: false,
    };
  }
  return roomState[code];
}

// ─── NTP-style sync helper ────────────────────────────────────────────────────
// Called in two situations:
//   1. Host explicitly picks a track  (via 'play-track')
//   2. All devices signal ready       (via 'device-ready', for initial autoplay)
//
// Sends { trackId, startAt } where startAt is an absolute Unix epoch-ms
// timestamp that is SYNC_BUFFER_MS in the future.  Every device schedules
// MediaPlayer.start() at exactly that moment via handler.postDelayed(delta).
// No 3-2-1 countdown — just silent, precise, wall-clock scheduling.
//
// 1500 ms is enough for:
//   • Android to call prepare() on a cached local file   (~5 ms)
//   • postDelayed scheduling jitter                       (~10 ms)
//   • Network RTT for the socket event to reach clients  (~50-300 ms)
// BeatSync.gg uses the same technique (epoch timestamp + client-side scheduling).
const SYNC_BUFFER_MS = 1500;

function broadcastPlay(io, code, trackId) {
  const startAt = Date.now() + SYNC_BUFFER_MS;
  io.to(code).emit('start-playback', { trackId, startAt });
}

module.exports = function initSocket(io) {
  io.on('connection', (socket) => {

    // ── join-room ─────────────────────────────────────────────────────────────
    socket.on('join-room', async ({ roomCode, userId, username }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      try {
        const [rows] = await db.query(
          'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE', [code]
        );
        if (!rows.length) {
          socket.emit('room-joined', { success: false, message: 'Room not found' });
          return;
        }

        socket.join(code);
        socket.data = { roomCode: code, userId, username };

        const s = getState(code);
        s.members.set(socket.id, { userId, username });
        if (rows[0].created_by === parseInt(userId)) s.hostSocketId = socket.id;

        socket.emit('room-joined', { success: true, listenerCount: s.members.size });
        socket.to(code).emit('listener-joined', { listenerCount: s.members.size, username });
      } catch (e) { console.error('join-room', e); }
    });

    // ── get-queue ─────────────────────────────────────────────────────────────
    socket.on('get-queue', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      try {
        const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [code]);
        if (!rooms.length) return;
        const [tracks] = await db.query(
          `SELECT id         AS trackId,
                  track_name AS trackName,
                  added_by   AS addedBy,
                  file_url   AS fileUrl
           FROM   queue
           WHERE  room_id = ?
           ORDER  BY order_index ASC`,
          [rooms[0].id]
        );
        socket.emit('queue-state', { tracks });
      } catch (e) { console.error('get-queue', e); }
    });

    // ── track-uploaded ────────────────────────────────────────────────────────
    // Broadcast new track to all room members so they can start downloading it.
    socket.on('track-uploaded', ({ roomCode, trackId, fileUrl, trackName, addedBy }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const s = getState(code);

      // Only update currentTrackId if nothing is playing yet (first track in room)
      if (!s.currentTrackId) {
        s.currentTrackId = trackId;
        s.readySet.clear();
        s.countdownActive = false;
      }

      io.to(code).emit('track-available', { trackId, fileUrl, trackName, addedBy });
    });

    // ── device-ready ──────────────────────────────────────────────────────────
    // Devices emit this after downloading the FIRST track (initial autoplay path).
    // When ALL members are ready, trigger NTP sync immediately — no countdown.
    socket.on('device-ready', ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const s = getState(code);
      s.readySet.add(socket.id);

      const allReady = s.readySet.size >= s.members.size && s.members.size > 0;
      if (allReady && !s.countdownActive && s.currentTrackId) {
        s.countdownActive = true;   // prevent double-fire
        broadcastPlay(io, code, s.currentTrackId);
        // Reset flag after the buffer window so future device-ready events work
        setTimeout(() => { s.countdownActive = false; }, SYNC_BUFFER_MS + 500);
      }
    });

    // ── play-track ────────────────────────────────────────────────────────────
    // Host explicitly picks a track (next / prev / queue tap / after track ends).
    // Immediately broadcast NTP-synced start-playback to ALL devices — no waiting
    // for device-ready, because the file should already be cached on every client.
    socket.on('play-track', ({ roomCode, trackId }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const s = getState(code);
      s.currentTrackId  = trackId;
      s.readySet.clear();         // reset ready set for this new track
      s.countdownActive = false;
      broadcastPlay(io, code, trackId);
    });

    // ── track-ended ───────────────────────────────────────────────────────────
    // Host's MediaPlayer fires onCompletion → host emits this.
    // Mark current track played in DB; the host's RoomActivity then calls
    // hostSwitchToIndex(next) which emits play-track — so we don't need to
    // emit start-playback here again (avoid double-play).
    socket.on('track-ended', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      try {
        const s = getState(code);
        if (s.currentTrackId) {
          await db.query('UPDATE queue SET is_played = TRUE WHERE id = ?', [s.currentTrackId]);
        }
      } catch (e) { console.error('track-ended', e); }
    });

    // ── playback controls (pause / resume / seek) ─────────────────────────────
    // Relay host commands to all OTHER members only (socket.to = exclude sender).
    socket.on('pause-track',  ({ roomCode, position }) =>
      socket.to(roomCode?.toUpperCase()).emit('playback-paused',  { position }));
    socket.on('resume-track', ({ roomCode, position }) =>
      socket.to(roomCode?.toUpperCase()).emit('playback-resumed', { position }));
    socket.on('seek-track',   ({ roomCode, position }) =>
      socket.to(roomCode?.toUpperCase()).emit('playback-seeked',  { position }));

    // ── leave / disconnect ────────────────────────────────────────────────────
    socket.on('leave-room',  ({ roomCode }) => handleLeave(io, socket, roomCode?.toUpperCase()));
    socket.on('disconnect',  ()            => {
      if (socket.data?.roomCode) handleLeave(io, socket, socket.data.roomCode);
    });
  });
};

// ─── handleLeave ─────────────────────────────────────────────────────────────
async function handleLeave(io, socket, code) {
  if (!code || !roomState[code]) return;
  const s = roomState[code];

  // Guard: don't process the same socket twice (disconnect can fire after leave-room)
  if (!s.members.has(socket.id)) return;

  const member = s.members.get(socket.id);
  s.members.delete(socket.id);
  s.readySet.delete(socket.id);
  socket.leave(code);

  if (s.hostSocketId === socket.id) {
    // Host left → close the room
    try { await db.query('UPDATE rooms SET is_active = FALSE WHERE code = ?', [code]); } catch {}
    io.to(code).emit('host-left', { message: 'Host left. Room closed.' });
    delete roomState[code];
  } else {
    // Regular listener left
    io.to(code).emit('listener-left', {
      listenerCount: s.members.size,
      username:      member?.username,
    });
  }
}
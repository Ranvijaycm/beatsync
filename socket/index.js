const db = require('../config/db');

// roomState[code] = {
//   hostSocketId:    string | null,
//   hostUserId:      number | null,
//   members:         Map<socketId, { userId, username }>   — keyed by socketId
//   userSockets:     Map<userId, socketId>                 — reverse lookup, one socket per user
//   readyUserIds:    Set<userId>                           — tracks who is ready by userId
//   currentTrackId:  number | null,
//   playbackActive:  boolean    — true while a track is playing (suppresses re-trigger)
// }
const roomState = {};

function getState(code) {
  if (!roomState[code]) {
    roomState[code] = {
      hostSocketId:   null,
      hostUserId:     null,
      members:        new Map(),   // socketId → { userId, username }
      userSockets:    new Map(),   // userId   → socketId  (latest socket for that user)
      readyUserIds:   new Set(),   // userId   → ready
      currentTrackId: null,
      playbackActive: false,
    };
  }
  return roomState[code];
}

// Unique human participants = number of entries in userSockets
function participantCount(s) {
  return s.userSockets.size;
}

// ── NTP broadcast ─────────────────────────────────────────────────────────────
const SYNC_BUFFER_MS = 1500;

function broadcastPlay(io, code, trackId) {
  const startAt = Date.now() + SYNC_BUFFER_MS;
  console.log(`[${code}] start-playback trackId=${trackId} startAt=${startAt}`);
  io.to(code).emit('start-playback', { trackId, startAt });
}

// ── Check if all unique users are ready ───────────────────────────────────────
function checkAllReady(io, code) {
  const s = getState(code);
  const total = participantCount(s);
  if (total === 0 || s.playbackActive || !s.currentTrackId) return;

  console.log(`[${code}] ready ${s.readyUserIds.size}/${total}`);

  if (s.readyUserIds.size >= total) {
    s.playbackActive = true;
    broadcastPlay(io, code, s.currentTrackId);
    // Reset after buffer so future track changes can trigger again
    setTimeout(() => { if (roomState[code]) roomState[code].playbackActive = false; }, SYNC_BUFFER_MS + 1000);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = function initSocket(io) {
  io.on('connection', (socket) => {

    // ── join-room ─────────────────────────────────────────────────────────────
    socket.on('join-room', async ({ roomCode, userId, username }) => {
      const code = roomCode?.toUpperCase();
      if (!code || !userId) return;

      try {
        const [rows] = await db.query(
          'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE', [code]
        );
        if (!rows.length) {
          socket.emit('room-joined', { success: false, message: 'Room not found' });
          return;
        }

        const s = getState(code);

        // ── Handle reconnect: same userId joining again ────────────────────
        // Remove old socket entry for this userId before adding the new one
        const oldSocketId = s.userSockets.get(userId);
        if (oldSocketId && oldSocketId !== socket.id) {
          s.members.delete(oldSocketId);
          // Keep readyUserIds entry — user was already ready before reconnect
          console.log(`[${code}] user ${userId} reconnected (old: ${oldSocketId} new: ${socket.id})`);
        }

        socket.join(code);
        socket.data = { roomCode: code, userId, username };

        s.members.set(socket.id, { userId, username });
        s.userSockets.set(userId, socket.id);   // always overwrite with latest socket

        // Mark host
        if (rows[0].created_by === parseInt(userId)) {
          s.hostSocketId = socket.id;
          s.hostUserId   = userId;
        }

        const count = participantCount(s);
        socket.emit('room-joined', { success: true, listenerCount: count });
        socket.to(code).emit('listener-joined', { listenerCount: count, username });

        console.log(`[${code}] joined userId=${userId} total=${count}`);
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
    socket.on('track-uploaded', ({ roomCode, trackId, fileUrl, trackName, addedBy }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const s = getState(code);

      // Only set currentTrackId if nothing is playing yet (first track in room)
      if (!s.currentTrackId) {
        s.currentTrackId = trackId;
        s.readyUserIds.clear();
        s.playbackActive = false;
      }

      io.to(code).emit('track-available', { trackId, fileUrl, trackName, addedBy });
      console.log(`[${code}] track-uploaded id=${trackId} current=${s.currentTrackId}`);
    });

    // ── device-ready ──────────────────────────────────────────────────────────
    // Client emits after downloading + caching the first track.
    // Tracked by userId so reconnects don't break the count.
    socket.on('device-ready', ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const s  = getState(code);
      const uid = socket.data?.userId;
      if (!uid) return;

      s.readyUserIds.add(uid);
      console.log(`[${code}] device-ready uid=${uid} ${s.readyUserIds.size}/${participantCount(s)}`);
      checkAllReady(io, code);
    });

    // ── play-track ────────────────────────────────────────────────────────────
    // Host picks a track explicitly — immediately broadcast NTP-synced play.
    socket.on('play-track', ({ roomCode, trackId }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      const s = getState(code);
      s.currentTrackId  = trackId;
      s.readyUserIds.clear();
      s.playbackActive  = false;
      broadcastPlay(io, code, trackId);
    });

    // ── track-ended ───────────────────────────────────────────────────────────
    socket.on('track-ended', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;
      try {
        const s = getState(code);
        if (s.currentTrackId) {
          await db.query('UPDATE queue SET is_played = TRUE WHERE id = ?', [s.currentTrackId]);
        }
        // Host's RoomActivity emits play-track next — no need to emit start-playback here
      } catch (e) { console.error('track-ended', e); }
    });

    // ── playback controls ─────────────────────────────────────────────────────
    socket.on('pause-track',  ({ roomCode, position }) =>
      socket.to(roomCode?.toUpperCase()).emit('playback-paused',  { position }));
    socket.on('resume-track', ({ roomCode, position }) =>
      socket.to(roomCode?.toUpperCase()).emit('playback-resumed', { position }));
    socket.on('seek-track',   ({ roomCode, position }) =>
      socket.to(roomCode?.toUpperCase()).emit('playback-seeked',  { position }));

    // ── leave / disconnect ────────────────────────────────────────────────────
    socket.on('leave-room',  ({ roomCode }) =>
      handleLeave(io, socket, roomCode?.toUpperCase(), true));
    socket.on('disconnect',  () => {
      if (socket.data?.roomCode) handleLeave(io, socket, socket.data.roomCode, false);
    });
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// handleLeave
//
// intentional = true  → user tapped Leave (remove permanently right away)
// intentional = false → socket dropped (minimize, network blip, file picker)
//   We wait 8 seconds before treating it as a real leave, so the user can
//   reconnect via onResume without being counted as having left.
// ─────────────────────────────────────────────────────────────────────────────
async function handleLeave(io, socket, code, intentional) {
  if (!code || !roomState[code]) return;
  const s = roomState[code];
  if (!s.members.has(socket.id)) return;  // already handled

  const member   = s.members.get(socket.id);
  const userId   = member?.userId;
  const username = member?.username;

  s.members.delete(socket.id);
  socket.leave(code);

  if (intentional) {
    if (s.userSockets.get(userId) === socket.id) {
      s.userSockets.delete(userId);
      s.readyUserIds.delete(userId);
    }
    await emitLeaveEvent(io, s, code, userId, username);
  } else {
    // Give 8 seconds for reconnect before treating as permanent leave
    setTimeout(async () => {
      if (!roomState[code]) return;
      if (s.userSockets.get(userId) === socket.id) {
        // User never reconnected with a new socket — treat as permanent leave
        s.userSockets.delete(userId);
        s.readyUserIds.delete(userId);
        console.log(`[${code}] userId=${userId} did not reconnect — removing`);
        await emitLeaveEvent(io, s, code, userId, username);
      }
      // else: user came back with a new socket — do nothing
    }, 8000);
  }
}

async function emitLeaveEvent(io, s, code, userId, username) {
  if (s.hostUserId === userId) {
    try { await db.query('UPDATE rooms SET is_active = FALSE WHERE code = ?', [code]); } catch {}
    io.to(code).emit('host-left', { message: 'Host left. Room closed.' });
    delete roomState[code];
    console.log(`[${code}] host left, room closed`);
  } else {
    const count = participantCount(s);
    io.to(code).emit('listener-left', { listenerCount: count, username });
    console.log(`[${code}] listener left userId=${userId} remaining=${count}`);
  }
}
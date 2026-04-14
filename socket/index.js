const db = require('../config/db');

const roomState = {};

function getState(code) {
  if (!roomState[code]) {
    roomState[code] = {
      hostSocketId: null,
      hostUserId: null,
      members: new Map(),
      userSockets: new Map(),
      readyUserIds: new Set(),
      currentTrackId: null,
      playbackActive: false,
    };
  }
  return roomState[code];
}

function participantCount(s) {
  return s.userSockets.size;
}

const SYNC_BUFFER_MS = 800;

function broadcastPlay(io, code, trackId) {
  const startAt = Date.now() + SYNC_BUFFER_MS;
  console.log(`[${code}] start-playback trackId=${trackId} startAt=${startAt}`);
  io.to(code).emit('start-playback', { trackId, startAt });
}

function checkAllReady(io, code) {
  const s = getState(code);
  const total = participantCount(s);
  if (total === 0 || s.playbackActive || !s.currentTrackId) return;

  console.log(`[${code}] ready ${s.readyUserIds.size}/${total}`);

  if (s.readyUserIds.size >= total) {
    s.playbackActive = true;
    broadcastPlay(io, code, s.currentTrackId);
    setTimeout(() => {
      if (roomState[code]) roomState[code].playbackActive = false;
    }, SYNC_BUFFER_MS + 1000);
  }
}

module.exports = function initSocket(io) {
  io.on('connection', (socket) => {
    socket.on('time-sync', ({ clientSentAt }) => {
      socket.emit('time-sync-response', {
        clientSentAt,
        serverTime: Date.now(),
      });
    });

    socket.on('join-room', async ({ roomCode, userId, username }) => {
      const code = roomCode?.toUpperCase();
      if (!code || !userId) return;

      try {
        const [rows] = await db.query(
          'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE',
          [code]
        );

        if (!rows.length) {
          socket.emit('room-joined', { success: false, message: 'Room not found' });
          return;
        }

        const s = getState(code);
        const oldSocketId = s.userSockets.get(userId);

        if (oldSocketId && oldSocketId !== socket.id) {
          s.members.delete(oldSocketId);
          console.log(`[${code}] user ${userId} reconnected (old: ${oldSocketId} new: ${socket.id})`);
        }

        socket.join(code);
        socket.data = { roomCode: code, userId, username };

        s.members.set(socket.id, { userId, username });
        s.userSockets.set(userId, socket.id);

        if (rows[0].created_by === parseInt(userId)) {
          s.hostSocketId = socket.id;
          s.hostUserId = userId;
        }

        const count = participantCount(s);
        socket.emit('room-joined', { success: true, listenerCount: count });
        socket.to(code).emit('listener-joined', { listenerCount: count, username });

        console.log(`[${code}] joined userId=${userId} total=${count}`);
      } catch (e) {
        console.error('join-room', e);
      }
    });

    socket.on('get-queue', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      try {
        const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [code]);
        if (!rooms.length) return;

        const [tracks] = await db.query(
          `SELECT id AS trackId,
                  track_name AS trackName,
                  added_by AS addedBy,
                  file_url AS fileUrl
           FROM queue
           WHERE room_id = ?
           ORDER BY order_index ASC`,
          [rooms[0].id]
        );

        socket.emit('queue-state', { tracks });
      } catch (e) {
        console.error('get-queue', e);
      }
    });

    socket.on('track-uploaded', ({ roomCode, trackId, fileUrl, trackName, addedBy }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const s = getState(code);

      if (!s.currentTrackId) {
        s.currentTrackId = trackId;
        s.readyUserIds.clear();
        s.playbackActive = false;
      }

      io.to(code).emit('track-available', { trackId, fileUrl, trackName, addedBy });
      console.log(`[${code}] track-uploaded id=${trackId} current=${s.currentTrackId}`);
    });

    socket.on('device-ready', ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const s = getState(code);
      const uid = socket.data?.userId;
      if (!uid) return;

      s.readyUserIds.add(uid);
      console.log(`[${code}] device-ready uid=${uid} ${s.readyUserIds.size}/${participantCount(s)}`);
      checkAllReady(io, code);
    });

    socket.on('play-track', ({ roomCode, trackId }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const s = getState(code);
      s.currentTrackId = trackId;
      s.readyUserIds.clear();
      s.playbackActive = false;

      broadcastPlay(io, code, trackId);
    });

    socket.on('track-ended', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      try {
        const s = getState(code);
        if (s.currentTrackId) {
          await db.query('UPDATE queue SET is_played = TRUE WHERE id = ?', [s.currentTrackId]);
        }
      } catch (e) {
        console.error('track-ended', e);
      }
    });

    socket.on('pause-track', ({ roomCode, position }) => {
      socket.to(roomCode?.toUpperCase()).emit('playback-paused', { position });
    });

    socket.on('resume-track', ({ roomCode, position }) => {
      socket.to(roomCode?.toUpperCase()).emit('playback-resumed', { position });
    });

    socket.on('seek-track', ({ roomCode, position }) => {
      socket.to(roomCode?.toUpperCase()).emit('playback-seeked', { position });
    });

    socket.on('leave-room', ({ roomCode }) => {
      handleLeave(io, socket, roomCode?.toUpperCase(), true);
    });

    socket.on('disconnect', () => {
      if (socket.data?.roomCode) {
        handleLeave(io, socket, socket.data.roomCode, false);
      }
    });
  });
};

async function handleLeave(io, socket, code, intentional) {
  if (!code || !roomState[code]) return;

  const s = roomState[code];
  if (!s.members.has(socket.id)) return;

  const member = s.members.get(socket.id);
  const userId = member?.userId;
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
    setTimeout(async () => {
      if (!roomState[code]) return;

      if (s.userSockets.get(userId) === socket.id) {
        s.userSockets.delete(userId);
        s.readyUserIds.delete(userId);

        console.log(`[${code}] userId=${userId} did not reconnect, removing`);
        await emitLeaveEvent(io, s, code, userId, username);
      }
    }, 8000);
  }
}

async function emitLeaveEvent(io, s, code, userId, username) {
  if (s.hostUserId === userId) {
    try {
      await db.query('UPDATE rooms SET is_active = FALSE WHERE code = ?', [code]);
    } catch {}

    io.to(code).emit('host-left', { message: 'Host left. Room closed.' });
    delete roomState[code];

    console.log(`[${code}] host left, room closed`);
  } else {
    const count = participantCount(s);

    io.to(code).emit('listener-left', { listenerCount: count, username });
    console.log(`[${code}] listener left userId=${userId} remaining=${count}`);
  }
}

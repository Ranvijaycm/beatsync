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

function participantCount(state) {
  return state.userSockets.size;
}

const SYNC_BUFFER_MS = 1500;

function broadcastPlay(io, code, trackId) {
  const startAt = Date.now() + SYNC_BUFFER_MS;
  console.log(`[${code}] start-playback trackId=${trackId} startAt=${startAt}`);
  io.to(code).emit('start-playback', { trackId, startAt });
}

function checkAllReady(io, code) {
  const state = getState(code);
  const total = participantCount(state);

  if (total === 0 || state.playbackActive || !state.currentTrackId) return;

  console.log(`[${code}] ready ${state.readyUserIds.size}/${total}`);

  if (state.readyUserIds.size >= total) {
    state.playbackActive = true;
    broadcastPlay(io, code, state.currentTrackId);

    setTimeout(() => {
      if (roomState[code]) {
        roomState[code].playbackActive = false;
      }
    }, SYNC_BUFFER_MS + 900);
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
          socket.emit('room-joined', {
            success: false,
            message: 'Room not found',
          });
          return;
        }

        const state = getState(code);
        const oldSocketId = state.userSockets.get(userId);

        if (oldSocketId && oldSocketId !== socket.id) {
          state.members.delete(oldSocketId);
          console.log(`[${code}] user ${userId} reconnected`);
        }

        socket.join(code);
        socket.data = { roomCode: code, userId, username };

        state.members.set(socket.id, { userId, username });
        state.userSockets.set(userId, socket.id);

        if (rows[0].created_by === parseInt(userId)) {
          state.hostSocketId = socket.id;
          state.hostUserId = userId;
        }

        const count = participantCount(state);

        socket.emit('room-joined', {
          success: true,
          listenerCount: count,
        });

        socket.to(code).emit('listener-joined', {
          listenerCount: count,
          username,
        });

        console.log(`[${code}] joined userId=${userId} total=${count}`);
      } catch (error) {
        console.error('join-room', error);
      }
    });

    socket.on('get-queue', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      try {
        const [rooms] = await db.query(
          'SELECT id FROM rooms WHERE code = ?',
          [code]
        );

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
      } catch (error) {
        console.error('get-queue', error);
      }
    });

    socket.on('track-uploaded', ({ roomCode, trackId, fileUrl, trackName, addedBy }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const state = getState(code);

      if (!state.currentTrackId) {
        state.currentTrackId = trackId;
        state.readyUserIds.clear();
        state.playbackActive = false;
      }

      io.to(code).emit('track-available', {
        trackId,
        fileUrl,
        trackName,
        addedBy,
      });

      console.log(`[${code}] track-uploaded id=${trackId} current=${state.currentTrackId}`);
    });

    socket.on('device-ready', ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      const state = getState(code);
      const userId = socket.data?.userId;
      if (!userId) return;

      state.readyUserIds.add(userId);
      console.log(`[${code}] device-ready userId=${userId} ${state.readyUserIds.size}/${participantCount(state)}`);

      checkAllReady(io, code);
    });

    socket.on('play-track', ({ roomCode, trackId }) => {
      const code = roomCode?.toUpperCase();
      if (!code || !trackId) return;

      const state = getState(code);

      state.currentTrackId = trackId;
      state.readyUserIds.clear();
      state.playbackActive = false;

      broadcastPlay(io, code, trackId);
    });

    socket.on('track-ended', async ({ roomCode }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      try {
        const state = getState(code);

        if (state.currentTrackId) {
          await db.query(
            'UPDATE queue SET is_played = TRUE WHERE id = ?',
            [state.currentTrackId]
          );
        }
      } catch (error) {
        console.error('track-ended', error);
      }
    });

    socket.on('pause-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      socket.to(code).emit('playback-paused', { position });
    });

    socket.on('resume-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      socket.to(code).emit('playback-resumed', { position });
    });

    socket.on('seek-track', ({ roomCode, position }) => {
      const code = roomCode?.toUpperCase();
      if (!code) return;

      socket.to(code).emit('playback-seeked', { position });
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

  const state = roomState[code];
  if (!state.members.has(socket.id)) return;

  const member = state.members.get(socket.id);
  const userId = member?.userId;
  const username = member?.username;

  state.members.delete(socket.id);
  socket.leave(code);

  if (intentional) {
    if (state.userSockets.get(userId) === socket.id) {
      state.userSockets.delete(userId);
      state.readyUserIds.delete(userId);
    }

    await emitLeaveEvent(io, state, code, userId, username);
    return;
  }

  setTimeout(async () => {
    if (!roomState[code]) return;

    if (state.userSockets.get(userId) === socket.id) {
      state.userSockets.delete(userId);
      state.readyUserIds.delete(userId);

      console.log(`[${code}] userId=${userId} did not reconnect, removing`);
      await emitLeaveEvent(io, state, code, userId, username);
    }
  }, 8000);
}

async function emitLeaveEvent(io, state, code, userId, username) {
  if (state.hostUserId === userId) {
    try {
      await db.query(
        'UPDATE rooms SET is_active = FALSE WHERE code = ?',
        [code]
      );
    } catch {}

    io.to(code).emit('host-left', {
      message: 'Host left. Room closed.',
    });

    delete roomState[code];
    console.log(`[${code}] host left, room closed`);
    return;
  }

  const count = participantCount(state);

  io.to(code).emit('listener-left', {
    listenerCount: count,
    username,
  });

  console.log(`[${code}] listener left userId=${userId} remaining=${count}`);
}

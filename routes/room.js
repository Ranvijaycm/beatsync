const express    = require('express');
const db         = require('../config/db');
const auth       = require('../middleware/auth');
const upload     = require('../middleware/upload');
const router     = express.Router();

function randomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// POST /room/create
router.post('/create', auth, async (req, res) => {
  try {
    let code, exists;
    do {
      code = randomCode();
      const [r] = await db.query('SELECT id FROM rooms WHERE code = ?', [code]);
      exists = r.length > 0;
    } while (exists);

    const [result] = await db.query(
      'INSERT INTO rooms (code, created_by) VALUES (?, ?)',
      [code, req.user.id]
    );
    res.status(201).json({ success: true, roomCode: code, isHost: true });
  } catch {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /room/join
router.post('/join', auth, async (req, res) => {
  const { roomCode } = req.body;
  if (!roomCode) return res.status(400).json({ success: false, message: 'roomCode required' });

  try {
    const [rows] = await db.query(
      'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE',
      [roomCode.toUpperCase()]
    );
    if (!rows.length) return res.status(404).json({ success: false, message: 'Room not found' });

    const room = rows[0];
    const isHost = room.created_by === req.user.id;
    res.json({ success: true, roomCode: room.code, isHost });
  } catch {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /room/queue/add  — multipart audio upload
router.post('/queue/add', auth, upload.single('audio'), async (req, res) => {
  const { roomCode, trackName, addedBy } = req.body;
  if (!roomCode || !trackName || !req.file)
    return res.status(400).json({ success: false, message: 'roomCode, trackName and audio required' });

  try {
    const [rooms] = await db.query(
      'SELECT * FROM rooms WHERE code = ? AND is_active = TRUE',
      [roomCode.toUpperCase()]
    );
    if (!rooms.length) return res.status(404).json({ success: false, message: 'Room not found' });

    const roomId = rooms[0].id;
    const [order] = await db.query(
      'SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM queue WHERE room_id = ?',
      [roomId]
    );
    const fileUrl = req.file.path; // Cloudinary URL

    const [result] = await db.query(
      'INSERT INTO queue (room_id, track_name, added_by, file_url, order_index) VALUES (?, ?, ?, ?, ?)',
      [roomId, trackName, addedBy || 'Unknown', fileUrl, order[0].next]
    );

    res.status(201).json({ success: true, trackId: result.insertId, fileUrl, trackName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /room/queue/:roomCode
router.get('/queue/:roomCode', auth, async (req, res) => {
  try {
    const [rooms] = await db.query('SELECT id FROM rooms WHERE code = ?', [req.params.roomCode.toUpperCase()]);
    if (!rooms.length) return res.status(404).json({ success: false, message: 'Room not found' });

    const [tracks] = await db.query(
      'SELECT id, track_name, added_by, file_url, order_index FROM queue WHERE room_id = ? ORDER BY order_index ASC',
      [rooms[0].id]
    );
    res.json({ success: true, tracks });
  } catch {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;

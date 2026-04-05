require('dotenv').config();
const express   = require('express');
const http      = require('http');
const { Server} = require('socket.io');
const cors      = require('cors');
const initSocket = require('./socket');
const authRoutes = require('./routes/auth');
const roomRoutes = require('./routes/room');
const db         = require('./config/db');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/auth', authRoutes);
app.use('/room', roomRoutes);
app.get('/', (_, res) => res.json({ success: true, message: 'BeatSync server running 🎵' }));

initSocket(io);

// Auto-create tables on start
async function initDb() {
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    full_name VARCHAR(100) NOT NULL,
    email VARCHAR(100) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS rooms (
    id INT AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(6) UNIQUE NOT NULL,
    created_by INT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS queue (
    id INT AUTO_INCREMENT PRIMARY KEY,
    room_id INT NOT NULL,
    track_name VARCHAR(255) NOT NULL,
    added_by VARCHAR(100) NOT NULL,
    file_url TEXT NOT NULL,
    order_index INT DEFAULT 0,
    is_played BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  console.log('✅ DB tables ready');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', async () => {
  await initDb();
  console.log(`🎵 BeatSync running on port ${PORT}`);
});

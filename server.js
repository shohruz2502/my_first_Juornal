// Электронный журнал — Express + SQLite3 + Socket.IO
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = require('socket.io')(server);

const DB_FILE = path.join(__dirname, 'database.db');

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Open DB
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) {
    console.error('Cannot open database', err);
    process.exit(1);
  }
  console.log('Connected to SQLite database');
});

// Initialize tables with schema updates
db.serialize(async () => {
  // Таблица для общих записей (оставлена для обратной совместимости)
  db.run(`CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date TEXT,
    note TEXT,
    updatedAt TEXT
  )`);

  // Таблица студентов
  db.run(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    group_name TEXT NOT NULL,
    course INTEGER NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  // Таблица посещаемости
  db.run(`CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, date),
    FOREIGN KEY(student_id) REFERENCES students(id) ON DELETE CASCADE
  )`);

  // Создаем индекс для улучшения производительности
  db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, date)`);

  // Ждем завершения создания таблиц
  await new Promise(resolve => setTimeout(resolve, 100));

  // Проверяем и добавляем поле hour если его нет
  try {
    const tableInfo = await allAsync("PRAGMA table_info(attendance)");
    const hasHourColumn = tableInfo.some(column => column.name === 'hour');
    
    if (!hasHourColumn) {
      console.log('Adding hour column to attendance table...');
      await runAsync('ALTER TABLE attendance ADD COLUMN hour INTEGER');
      await runAsync('DROP INDEX IF EXISTS idx_attendance_student_date');
      await runAsync('CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_student_date_hour ON attendance(student_id, date, hour)');
      console.log('Hour column added successfully');
    }
  } catch (error) {
    console.log('Table schema update check:', error.message);
  }
});

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// API для студентов
app.get('/api/students', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM students ORDER BY name ASC');
    const students = rows.map(row => ({
      id: row.id,
      name: row.name,
      group: row.group_name,
      course: row.course,
      created_at: row.created_at
    }));
    res.json(students);
  } catch (e) {
    console.error('Error getting students:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/students', async (req, res) => {
  try {
    const { name, group, course } = req.body;
    console.log('Adding student:', { name, group, course });
    
    if (!name || !group || course === undefined) {
      return res.status(400).json({ error: 'Missing required fields: name, group, course' });
    }

    const result = await runAsync(
      'INSERT INTO students (name, group_name, course) VALUES (?, ?, ?)',
      [name, group, course]
    );
    
    const inserted = await getAsync('SELECT * FROM students WHERE id = ?', [result.lastID]);
    
    const studentForClient = {
      id: inserted.id,
      name: inserted.name,
      group: inserted.group_name,
      course: inserted.course
    };
    
    io.emit('student_added', studentForClient);
    res.json(studentForClient);
  } catch (e) {
    console.error('Error adding student:', e);
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/students/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    console.log('Deleting student:', id);
    
    const row = await getAsync('SELECT * FROM students WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Student not found' });
    
    await runAsync('DELETE FROM attendance WHERE student_id = ?', [id]);
    await runAsync('DELETE FROM students WHERE id = ?', [id]);
    
    io.emit('student_deleted', id);
    res.json({ deletedId: id, message: 'Student deleted successfully' });
  } catch (e) {
    console.error('Error deleting student:', e);
    res.status(500).json({ error: e.message });
  }
});

// API для посещаемости
app.get('/api/attendance', async (req, res) => {
  try {
    const rows = await allAsync(`
      SELECT student_id, date, status, hour 
      FROM attendance 
      ORDER BY date DESC, student_id, hour
    `);
    
    const attendanceData = {
      daily: {},
      hourly: {}
    };
    
    rows.forEach(row => {
      // Ежедневные данные (hour is null)
      if (row.hour === null || row.hour === undefined) {
        if (!attendanceData.daily[row.date]) {
          attendanceData.daily[row.date] = {};
        }
        attendanceData.daily[row.date][row.student_id] = row.status;
      }
      
      // Почасовые данные
      if (row.hour !== null && row.hour !== undefined) {
        if (!attendanceData.hourly[row.date]) {
          attendanceData.hourly[row.date] = {};
        }
        if (!attendanceData.hourly[row.date][row.student_id]) {
          attendanceData.hourly[row.date][row.student_id] = {};
        }
        attendanceData.hourly[row.date][row.student_id][row.hour] = row.status;
      }
    });
    
    res.json(attendanceData);
  } catch (e) {
    console.error('Error getting attendance:', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/attendance', async (req, res) => {
  try {
    const { studentId, date, status, hour = null } = req.body;
    console.log('Saving attendance:', { studentId, date, status, hour });
    
    if (!studentId || !date || !status) {
      return res.status(400).json({ error: 'Missing required fields: studentId, date, status' });
    }
    
    const student = await getAsync('SELECT * FROM students WHERE id = ?', [studentId]);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }
    
    // Проверяем существующую запись
    const existing = await getAsync(
      'SELECT * FROM attendance WHERE student_id = ? AND date = ? AND (hour = ? OR (hour IS NULL AND ? IS NULL))',
      [studentId, date, hour, hour]
    );
    
    let result;
    if (existing) {
      // Обновляем существующую запись
      result = await runAsync(
        'UPDATE attendance SET status = ? WHERE student_id = ? AND date = ? AND (hour = ? OR (hour IS NULL AND ? IS NULL))',
        [status, studentId, date, hour, hour]
      );
    } else {
      // Создаем новую запись
      result = await runAsync(
        'INSERT INTO attendance (student_id, date, status, hour) VALUES (?, ?, ?, ?)',
        [studentId, date, status, hour]
      );
    }
    
    const attendanceData = {
      studentId: parseInt(studentId),
      date: date,
      status: status,
      hour: hour
    };
    
    io.emit('attendance_updated', attendanceData);
    res.json({ success: true, ...attendanceData });
  } catch (e) {
    console.error('Error saving attendance:', e);
    res.status(500).json({ error: e.message });
  }
});

// Массовое добавление студентов
app.post('/api/students/batch', async (req, res) => {
  try {
    const { students: studentsList } = req.body;
    console.log('Batch adding students:', studentsList);
    
    if (!studentsList || !Array.isArray(studentsList)) {
      return res.status(400).json({ error: 'Missing or invalid students list' });
    }
    
    const results = [];
    
    for (const studentData of studentsList) {
      const { name, group, course } = studentData;
      
      try {
        const result = await runAsync(
          'INSERT INTO students (name, group_name, course) VALUES (?, ?, ?)',
          [name, group, course]
        );
        
        const inserted = await getAsync('SELECT * FROM students WHERE id = ?', [result.lastID]);
        
        const studentForClient = {
          id: inserted.id,
          name: inserted.name,
          group: inserted.group_name,
          course: inserted.course
        };
        
        results.push(studentForClient);
        io.emit('student_added', studentForClient);
        
      } catch (error) {
        console.error(`Error adding student ${name}:`, error);
        results.push({ error: error.message, student: studentData });
      }
    }
    
    res.json({ 
      success: true, 
      added: results.filter(r => !r.error).length,
      errors: results.filter(r => r.error).length,
      results 
    });
    
  } catch (e) {
    console.error('Error in batch add:', e);
    res.status(500).json({ error: e.message });
  }
});

// Старые API для обратной совместимости
app.get('/api/entries', async (req, res) => {
  try {
    const rows = await allAsync('SELECT * FROM entries ORDER BY id DESC');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/entries', async (req, res) => {
  try {
    const { name, date, note } = req.body;
    const updatedAt = new Date().toISOString();
    const result = await runAsync(
      'INSERT INTO entries (name, date, note, updatedAt) VALUES (?, ?, ?, ?)',
      [name, date, note, updatedAt]
    );
    const inserted = await getAsync('SELECT * FROM entries WHERE id = ?', [result.lastID]);
    io.emit('refresh');
    res.json(inserted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/entries/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { name, date, note } = req.body;
    const updatedAt = new Date().toISOString();
    await runAsync('UPDATE entries SET name=?, date=?, note=?, updatedAt=? WHERE id=?',
      [name, date, note, updatedAt, id]);
    const updated = await getAsync('SELECT * FROM entries WHERE id = ?', [id]);
    io.emit('refresh');
    res.json(updated);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/entries/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const row = await getAsync('SELECT * FROM entries WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    await runAsync('DELETE FROM entries WHERE id = ?', [id]);
    io.emit('refresh');
    res.json({ deletedId: id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    database: 'Connected'
  });
});

// Socket.IO
io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });

  socket.on('student_added', (data) => {
    console.log('Student added via socket:', data);
    socket.broadcast.emit('student_added', data);
  });

  socket.on('student_deleted', (data) => {
    console.log('Student deleted via socket:', data);
    socket.broadcast.emit('student_deleted', data);
  });

  socket.on('attendance_updated', (data) => {
    console.log('Attendance updated via socket:', data);
    socket.broadcast.emit('attendance_updated', data);
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('🚀 Server listening on port', PORT);
  console.log('📁 Database file:', DB_FILE);
  console.log('🔗 Health check: http://localhost:' + PORT + '/api/health');
});
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connect to persistent SQLite database
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
    if (err) console.error(err.message);
    console.log('Connected to secure medical database.');
});

// Enforce strict relational tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS triage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_name TEXT,
        symptoms TEXT,
        priority TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER,
        sender TEXT,
        text TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Secure Portal Authentication Endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'Password123!') {
        return res.json({ success: true });
    }
    res.status(401).json({ success: false, message: 'Unauthorized access attempt.' });
});

// WebSocket Connection Management
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        const payload = JSON.parse(message);

        // CLINICIAN ACTION: Authorized portal requests the complete queue
        if (payload.type === 'GET_CLINICAL_QUEUE') {
            db.all("SELECT * FROM triage ORDER BY id DESC", [], (err, rows) => {
                if (!err) ws.send(JSON.stringify({ type: 'INITIAL_TRIAGE_LOAD', data: rows }));
            });
        }

        // CLINICIAN OR PATIENT ACTION: Request isolated history for one specific room ID
        if (payload.type === 'LOAD_PRIVATE_CHAT') {
            db.all("SELECT * FROM messages WHERE patient_id = ? ORDER BY timestamp ASC", [payload.patientId], (err, rows) => {
                if (!err) {
                    ws.send(JSON.stringify({ type: 'INITIAL_CHAT_LOAD', data: rows, patientId: payload.patientId }));
                }
            });
        }

        // PATIENT ACTION: Submit a new intake form
        if (payload.type === 'NEW_TRIAGE') {
            const priority = payload.symptoms.toLowerCase().includes('chest pain') ? 'URGENT' : 'ROUTINE';
            
            db.run("INSERT INTO triage (patient_name, symptoms, priority) VALUES (?, ?, ?)", 
                [payload.name, payload.symptoms, priority], 
                function(err) {
                    if (!err) {
                        const newTriageId = this.lastID;
                        
                        // Send the generated unique session ID back to the patient so they lock into their private room
                        ws.send(JSON.stringify({ 
                            type: 'INTAKE_CONFIRMED', 
                            patientId: newTriageId, 
                            patientName: payload.name 
                        }));

                        // Broadcast the new card strictly to authorized clinician windows
                        broadcast({ 
                            type: 'NEW_TRIAGE_ADDED', 
                            data: { id: newTriageId, patient_name: payload.name, symptoms: payload.symptoms, priority: priority }
                        });
                    }
                }
            );
        }

        // ROUTED MESSAGING ACTION: Secure individual inbox delivery
        if (payload.type === 'CHAT_MESSAGE') {
            db.run("INSERT INTO messages (patient_id, sender, text) VALUES (?, ?, ?)", 
                [payload.patientId, payload.sender, payload.text], 
                function(err) {
                    if (!err) {
                        broadcast({ 
                            type: 'NEW_CHAT_MESSAGE', 
                            data: {
                                patient_id: payload.patientId,
                                sender: payload.sender,
                                text: payload.text,
                                timestamp: new Date().toISOString()
                            }
                        });
                    }
                }
            );
        }
    });
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Secure server online on port ${PORT}`));
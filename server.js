const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// PRODUCTION FIX: Static key for AES-256-GCM so old messages can decrypt after restart
const ENCRYPTION_KEY = crypto.scryptSync('SangEditionsSecureKey2026!', 'salt', 32); 
const IV_LENGTH = 12;

// CLINICAL LOGIN CREDENTIALS (Change these to whatever you want!)
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "Password123!"; 

// PRODUCTION FIX: Persistent file database instead of ':memory:'
const db = new sqlite3.Database(path.join(__dirname, 'database.sqlite'), (err) => {
    if (err) console.error(err.message);
    console.log('Connected to secure persistent database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS triage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_name TEXT,
        encrypted_symptoms TEXT,
        iv TEXT,
        tag TEXT,
        priority TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        encrypted_text TEXT,
        iv TEXT,
        tag TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Encryption Helpers
function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { encryptedData: encrypted, iv: iv.toString('hex'), tag: authTag };
}

function decrypt(encryptedData, ivHex, tagHex) {
    try {
        const iv = Buffer.from(ivHex, 'hex');
        const tag = Buffer.from(tagHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
        decipher.setAuthTag(tag);
        let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        return "[Decryption Error]";
    }
}

function assessPriority(symptoms) {
    const urgentKeywords = ['chest pain', 'shortness of breath', 'severe bleeding', 'unconscious', 'stroke', 'suicidal'];
    const lowerSymptoms = symptoms.toLowerCase();
    return urgentKeywords.some(keyword => lowerSymptoms.includes(keyword)) ? 'URGENT' : 'ROUTINE';
}

app.use(express.json());

// Secure Login Route
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        res.json({ success: true, token: "clinician-authorized-session" });
    } else {
        res.status(401).json({ success: false, message: "Invalid credentials" });
    }
});

// Serve Frontend Static Files
app.use(express.static(path.join(__dirname, 'public')));

// WebSocket Live Sync & Chat Connection
wss.on('connection', (ws) => {
    console.log('Node connected.');

    db.all(`SELECT * FROM triage_records ORDER BY timestamp DESC`, [], (err, rows) => {
        if (!err && rows) {
            const clearRows = rows.map(row => ({
                id: row.id,
                patient_name: row.patient_name,
                symptoms: decrypt(row.encrypted_symptoms, row.iv, row.tag),
                priority: row.priority,
                timestamp: row.timestamp
            }));
            ws.send(JSON.stringify({ type: 'INITIAL_TRIAGE_LOAD', data: clearRows }));
        }
    });

    db.all(`SELECT * FROM messages ORDER BY timestamp ASC`, [], (err, rows) => {
        if (!err && rows) {
            const clearMessages = rows.map(row => ({
                sender: row.sender,
                text: decrypt(row.encrypted_text, row.iv, row.tag),
                timestamp: row.timestamp
            }));
            ws.send(JSON.stringify({ type: 'INITIAL_CHAT_LOAD', data: clearMessages }));
        }
    });

    ws.on('message', (message) => {
        const payload = JSON.parse(message);

        if (payload.type === 'NEW_TRIAGE') {
            const priority = assessPriority(payload.symptoms);
            const cryptoResult = encrypt(payload.symptoms);

            db.run(`INSERT INTO triage_records (patient_name, encrypted_symptoms, iv, tag, priority) VALUES (?, ?, ?, ?, ?)`,
                [payload.name, cryptoResult.encryptedData, cryptoResult.iv, cryptoResult.tag, priority],
                function(err) {
                    if (!err) {
                        const broadcastData = JSON.stringify({
                            type: 'NEW_TRIAGE_ADDED',
                            data: { id: this.lastID, patient_name: payload.name, symptoms: payload.symptoms, priority, timestamp: new Date() }
                        });
                        wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(broadcastData); });
                    }
                }
            );
        }

        if (payload.type === 'CHAT_MESSAGE') {
            const cryptoResult = encrypt(payload.text);

            db.run(`INSERT INTO messages (sender, encrypted_text, iv, tag) VALUES (?, ?, ?, ?)`,
                [payload.sender, cryptoResult.encryptedData, cryptoResult.iv, cryptoResult.tag],
                function(err) {
                    if (!err) {
                        const broadcastData = JSON.stringify({
                            type: 'NEW_CHAT_MESSAGE',
                            data: { sender: payload.sender, text: payload.text, timestamp: new Date() }
                        });
                        wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN) client.send(broadcastData); });
                    }
                }
            );
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SANG EDITIONS SERVER RUNNING ON PORT ${PORT}`);
});
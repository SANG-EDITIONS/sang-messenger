const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Security Configuration (For demonstration; use a persistent 32-byte key in production)
const ENCRYPTION_KEY = crypto.randomBytes(32); 
const IV_LENGTH = 12; // For AES-256-GCM

// Initialize Database
const db = new sqlite3.Database(':memory:', (err) => {
    if (err) console.error(err.message);
    console.log('Connected to secure in-memory triage database.');
});

db.serialize(() => {
    db.run(`CREATE TABLE triage_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_name TEXT,
        encrypted_symptoms TEXT,
        iv TEXT,
        tag TEXT,
        priority TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        encrypted_text TEXT,
        iv TEXT,
        tag TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Encryption Helper Functions
function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return { encryptedData: encrypted, iv: iv.toString('hex'), tag: authTag };
}

function decrypt(encryptedData, ivHex, tagHex) {
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encryptedData, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
}

// Automated Triage Rule Engine
function assessPriority(symptoms) {
    const urgentKeywords = ['chest pain', 'shortness of breath', 'severe bleeding', 'unconscious', 'stroke', 'suicidal'];
    const lowerSymptoms = symptoms.toLowerCase();
    return urgentKeywords.some(keyword => lowerSymptoms.includes(keyword)) ? 'URGENT' : 'ROUTINE';
}

// Serve Frontend Static Files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// WebSocket Live Sync & Chat Connection
wss.on('connection', (ws) => {
    console.log('Authorized clinical interface node connected.');

    // Fetch and send existing database state upon connection
    db.all(`SELECT * FROM triage_records ORDER BY timestamp DESC`, [], (err, rows) => {
        if (!err) {
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
        if (!err) {
            const clearMessages = rows.map(row => ({
                sender: row.sender,
                text: decrypt(row.encrypted_text, row.iv, row.tag),
                timestamp: row.timestamp
            }));
            ws.send(JSON.stringify({ type: 'INITIAL_CHAT_LOAD', data: clearMessages }));
        }
    });

    // Handle Incoming Actions
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

// Run Server
const PORT = 3000;
server.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(` SANG EDITIONS MESSENGER SERVER RUNNING`);
    console.log(` Local Access Link: http://localhost:${PORT}`);
    console.log(`=================================================`);
});
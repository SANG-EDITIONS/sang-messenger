const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Clinician Credentials
const CLINICIAN_USER = "drsang";
const CLINICIAN_PASS = "secure123";

app.use(express.static('public'));
app.use(express.json());

// Authentication endpoint
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === CLINICIAN_USER && password === CLINICIAN_PASS) {
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

// WebSocket handling
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        // Broadcast incoming messages to all connected clients
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(message.toString());
            }
        });
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
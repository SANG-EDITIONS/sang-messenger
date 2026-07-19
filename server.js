const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// PREFERRED CLINICIAN CREDENTIALS
const CLINICIAN_USER = "drsang";
const CLINICIAN_PASS = "secure123";

// In-memory clinical data stores
let triageQueue = [];
let conversationLogs = {}; 

// Secure Authentication Endpoint
app.post('/api/login', (req, { username, password }, res) => {
    if (username === CLINICIAN_USER && password === CLINICIAN_PASS) {
        return res.json({ success: true, message: "Authorized" });
    }
    return res.status(401).json({ success: false, message: "Invalid Parameters" });
});

// Serve Frontend App Layout
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Live WebSocket Communication Engine
wss.on('connection', (ws) => {
    ws.on('message', (message) => {
        try {
            const payload = JSON.parse(message);

            if (payload.type === 'GET_CLINICAL_QUEUE') {
                ws.send(JSON.stringify({ type: 'INITIAL_TRIAGE_LOAD', data: triageQueue }));
            }

            if (payload.type === 'NEW_TRIAGE') {
                const newPatientId = 'p_' + Date.now();
                const triageItem = {
                    id: newPatientId,
                    patient_name: payload.name,
                    symptoms: payload.symptoms,
                    priority: payload.symptoms.toLowerCase().includes('pain') || payload.symptoms.toLowerCase().includes('severe') ? 'URGENT' : 'ROUTINE',
                    timestamp: new Date()
                };

                triageQueue.push(triageItem);
                conversationLogs[newPatientId] = [];

                ws.send(JSON.stringify({ type: 'INTAKE_CONFIRMED', patientId: newPatientId }));
                
                // Broadcast update to connected clinician portals
                wss.clients.forEach(client => {
                    if (client !== ws && client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'NEW_TRIAGE_ADDED', data: triageItem }));
                    }
                });
            }

            if (payload.type === 'LOAD_PRIVATE_CHAT') {
                const logs = conversationLogs[payload.patientId] || [];
                ws.send(JSON.stringify({ type: 'INITIAL_CHAT_LOAD', patientId: payload.patientId, data: logs }));
            }

            if (payload.type === 'CHAT_MESSAGE') {
                const msgObj = {
                    patient_id: payload.patientId,
                    sender: payload.sender, // 'Clinician' or 'Patient'
                    text: payload.text,
                    timestamp: new Date()
                };

                if (!conversationLogs[payload.patientId]) {
                    conversationLogs[payload.patientId] = [];
                }
                conversationLogs[payload.patientId].push(msgObj);

                // Broadcast live chat message back to the active pair
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN) {
                        client.send(JSON.stringify({ type: 'NEW_CHAT_MESSAGE', data: msgObj }));
                    }
                });
            }
        } catch (e) {
            console.error("Payload processing error", e);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SANG Messenger Server running on port ${PORT}`);
});
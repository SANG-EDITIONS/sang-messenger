const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Mock Credentials for Clinician Login
const CLINICIAN_USER = "drsang";
const CLINICIAN_PASS = "secure123";

// Real-time server storage lists
let triageQueue = [];
let chatMessages = [];
let activeConnections = new Set();

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === CLINICIAN_USER && password === CLINICIAN_PASS) {
        return res.json({ success: true });
    }
    return res.status(401).json({ success: false, error: "Unauthorized Identity" });
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    activeConnections.add(ws);

    ws.on('message', (message) => {
        let payload;
        try {
            payload = JSON.parse(message);
        } catch (e) {
            return;
        }

        // 1. Clinician requests the global queue
        if (payload.type === 'GET_CLINICAL_QUEUE') {
            ws.userRole = 'clinician';
            ws.send(JSON.stringify({ type: 'INITIAL_TRIAGE_LOAD', data: triageQueue }));
        }

        // 2. Patient submits an intake form
        if (payload.type === 'NEW_TRIAGE') {
            const newPatientId = 'p-' + Math.random().toString(36).substr(2, 9);
            ws.userRole = 'patient';
            ws.patientRoomId = newPatientId;

            const triageItem = {
                id: newPatientId,
                patient_name: payload.name,
                symptoms: payload.symptoms,
                priority: "ROUTINE",
                timestamp: new Date()
            };

            triageQueue.push(triageItem);

            // Confirm back to this exact patient device
            ws.send(JSON.stringify({ type: 'INTAKE_CONFIRMED', patientId: newPatientId }));

            // Broadcast new patient card to any logged-in clinicians instantly
            activeConnections.forEach(client => {
                if (client.readyState === WebSocket.OPEN && client.userRole === 'clinician') {
                    client.send(JSON.stringify({ type: 'NEW_TRIAGE_ADDED', data: triageItem }));
                }
            });
        }

        // 3. Requesting chat history for an isolated room
        if (payload.type === 'LOAD_PRIVATE_CHAT') {
            const roomLogs = chatMessages.filter(m => m.patient_id === payload.patientId);
            ws.send(JSON.stringify({ type: 'INITIAL_CHAT_LOAD', data: roomLogs, patientId: payload.patientId }));
        }

        // 4. Two-Way WhatsApp Message Relay
        if (payload.type === 'CHAT_MESSAGE') {
            const msgObj = {
                patient_id: payload.patientId,
                sender: payload.sender, // 'Clinician' or 'Patient'
                text: payload.text,
                timestamp: new Date()
            };

            chatMessages.push(msgObj);

            // Broadcast to the exact patient and clinician looking at this room
            activeConnections.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    const isTargetClinician = (client.userRole === 'clinician');
                    const isTargetPatient = (client.userRole === 'patient' && client.patientRoomId === payload.patientId);
                    
                    if (isTargetClinician || isTargetPatient) {
                        client.send(JSON.stringify({ type: 'NEW_CHAT_MESSAGE', data: msgObj }));
                    }
                }
            });
        }
    });

    ws.on('close', () => {
        activeConnections.delete(ws);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Secure Server Active on Port ${PORT}`));
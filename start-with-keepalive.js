#!/usr/bin/env node

const { spawn } = require('child_process');
require('path');
console.log('🚀 Starting TELH Tipovačka with keep-alive service...');

// Spustit hlavní server
const serverProcess = spawn('node', ['server.js'], {
    stdio: 'inherit',
    cwd: __dirname
});

// Počkat 5 sekund a spustit self-ping service
setTimeout(() => {
    console.log('🔄 Starting self-ping service...');
    const pingProcess = spawn('node', ['scripts/selfPing.js'], {
        stdio: 'inherit',
        cwd: __dirname
    });
    
    pingProcess.on('error', (error) => {
        console.error('❌ Self-ping service error:', error);
    });
    
    pingProcess.on('close', (code) => {
        console.log(`Self-ping service exited with code ${code}`);
    });
}, 5000);

serverProcess.on('error', (error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
});

serverProcess.on('close', (code) => {
    console.log(`Server exited with code ${code}`);
    process.exit(code);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down gracefully...');
    serverProcess.kill('SIGINT');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Shutting down gracefully...');
    serverProcess.kill('SIGTERM');
    process.exit(0);
});

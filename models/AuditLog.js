const { AuditLogs } = require('../utils/mongoDataAccess');

class AuditLog {
    constructor(data) {
        this.id = data.id || Date.now().toString();
        this.timestamp = data.timestamp || new Date().toISOString();
        this.username = data.username || 'system';
        this.action = data.action; // např. 'create', 'update', 'delete', 'login', 'logout'
        this.entity = data.entity; // např. 'match', 'team', 'league', 'user'
        this.entityId = data.entityId || null;
        this.details = data.details || {};
        this.ip = data.ip || null;
        this.userAgent = data.userAgent || null;
    }

    static async log(username, action, entity, entityId = null, details = {}, req = null) {
        const logData = {
            username,
            action,
            entity,
            entityId,
            details,
            ip: req?.ip || req?.connection?.remoteAddress || null,
            userAgent: req?.get('User-Agent') || null
        };

        const auditLog = new AuditLog(logData);
        
        // Uložit do MongoDB
        await AuditLogs.add(auditLog);
        
        // Uložit i do admin_log.txt pro kompatibilitu
        const fs = require('fs');
        const time = new Date().toISOString();
        const logMessage = `[${time}] ADMIN: ${username} | AKCE: ${action} | ENTITY: ${entity} | DETAILY: ${JSON.stringify(details)}\n`;
        try {
            fs.appendFileSync('./data/admin_log.txt', logMessage);
        } catch (e) {
            console.error('Chyba při zápisu do admin_log.txt:', e);
        }
        
        return auditLog;
    }

    static async findAll(filters = {}) {
        return await AuditLogs.findAll(filters);
    }

    static async findById(id) {
        const logs = await AuditLogs.findAll();
        return logs.find(log => log.id === id);
    }

    static async findByUsername(username) {
        const logs = await AuditLogs.findAll();
        return logs.filter(log => log.username === username);
    }

    static async findByEntity(entity, entityId = null) {
        const logs = await AuditLogs.findAll();
        return logs.filter(log => 
            log.entity === entity && 
            (entityId === null || log.entityId === entityId)
        );
    }

    static async findByDateRange(startDate, endDate) {
        const logs = await AuditLogs.findAll();
        return logs.filter(log => {
            const logDate = new Date(log.timestamp);
            return logDate >= new Date(startDate) && logDate <= new Date(endDate);
        });
    }

    toJSON() {
        return {
            id: this.id,
            timestamp: this.timestamp,
            username: this.username,
            action: this.action,
            entity: this.entity,
            entityId: this.entityId,
            details: this.details,
            ip: this.ip,
            userAgent: this.userAgent
        };
    }
}

module.exports = AuditLog;

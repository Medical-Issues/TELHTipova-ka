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
        this.severity = data.severity || 'info'; // 'info', 'warning', 'error', 'critical'
        this.userRole = data.userRole || 'user'; // 'admin', 'user'
        this.success = data.success !== false; // default true, false pro neúspěšné akce
    }

    static async log(username, action, entity, entityId = null, details = {}, req = null, severity = 'info', userRole = 'user', success = true) {
        const logData = {
            username,
            action,
            entity,
            entityId,
            details,
            ip: req?.ip || req?.connection?.remoteAddress || null,
            userAgent: req?.get('User-Agent') || null,
            severity,
            userRole,
            success
        };

        const auditLog = new AuditLog(logData);

        // Uložit do MongoDB
        await AuditLogs.insertOne(auditLog);

        // Automatická notifikace při critical severity
        if (severity === 'critical') {
            try {
                const { notifyCriticalEvent } = require('../routes/notificationService');
                await notifyCriticalEvent(username, action, entity, entityId, details, logData.ip);
            } catch (notifError) {
                console.error('Chyba při odesílání critical notifikace:', notifError);
            }
        }

        // Uložit i do admin_log.txt pro kompatibilitu
        const fs = require('fs');
        const time = new Date().toISOString();
        const logMessage = `[${time}] ADMIN: ${username} | AKCE: ${action} | ENTITY: ${entity} | ENTITY_ID: ${entityId || 'N/A'} | IP: ${logData.ip || 'N/A'} | DETAILY: ${JSON.stringify(details)}\n`;
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
}

module.exports = AuditLog;

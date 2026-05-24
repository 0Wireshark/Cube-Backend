/**
 * Database operations for fingerprints
 * Optimized with caching and batch operations
 */

const Fingerprint = require('../../model/fingerprint');
const { calculateFingerprintHash } = require('../scoring/calculator');

// Cache pour éviter requêtes DB répétées (TTL: 5 minutes)
const fingerprintCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Sauvegarde ou met à jour un fingerprint
 */
async function saveFingerprint(accountId, fingerprintData, scores, flags) {
    try {
        const fingerprintHash = calculateFingerprintHash(fingerprintData.hwid);
        
        const existing = await Fingerprint.findOne({ accountId }).sort({ 'history.lastSeen': -1 });
        
        if (existing) {
            // Détecter les changements
            const changes = detectChanges(existing.hwid, fingerprintData.hwid);
            
            // Mettre à jour
            existing.fingerprintHash = fingerprintHash;
            existing.hwid = fingerprintData.hwid;
            existing.network = fingerprintData.network;
            existing.scores = scores;
            existing.flags = flags;
            existing.history.lastSeen = new Date();
            existing.history.seenCount += 1;
            
            // Ajouter IP à l'historique
            if (fingerprintData.network && fingerprintData.network.ip) {
                existing.history.ipHistory.push({
                    ip: fingerprintData.network.ip,
                    timestamp: new Date()
                });
                
                // Garder seulement les 50 dernières IPs
                if (existing.history.ipHistory.length > 50) {
                    existing.history.ipHistory = existing.history.ipHistory.slice(-50);
                }
            }
            
            // Ajouter changements à l'historique
            if (changes.length > 0) {
                existing.history.changes.push(...changes);
                
                // Garder seulement les 100 derniers changements
                if (existing.history.changes.length > 100) {
                    existing.history.changes = existing.history.changes.slice(-100);
                }
            }
            
            await existing.save();
            
            // Mettre à jour le cache
            fingerprintCache.set(accountId, {
                data: existing,
                timestamp: Date.now()
            });
            
            return existing;
        } else {
            // Créer nouveau fingerprint
            const newFingerprint = new Fingerprint({
                accountId,
                fingerprintHash,
                hwid: fingerprintData.hwid,
                network: fingerprintData.network,
                scores,
                flags,
                history: {
                    firstSeen: new Date(),
                    lastSeen: new Date(),
                    seenCount: 1,
                    ipHistory: fingerprintData.network && fingerprintData.network.ip ? [{
                        ip: fingerprintData.network.ip,
                        timestamp: new Date()
                    }] : [],
                    changes: []
                },
                metadata: fingerprintData.metadata || {}
            });
            
            await newFingerprint.save();
            
            // Mettre en cache
            fingerprintCache.set(accountId, {
                data: newFingerprint,
                timestamp: Date.now()
            });
            
            return newFingerprint;
        }
    } catch (error) {
        throw new Error(`Failed to save fingerprint: ${error.message}`);
    }
}

/**
 * Récupère le fingerprint d'un compte (avec cache)
 */
async function getFingerprint(accountId) {
    try {
        // Vérifier le cache
        const cached = fingerprintCache.get(accountId);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return cached.data;
        }
        
        // Récupérer depuis DB
        const fingerprint = await Fingerprint.findOne({ accountId }).sort({ 'history.lastSeen': -1 });
        
        if (fingerprint) {
            fingerprintCache.set(accountId, {
                data: fingerprint,
                timestamp: Date.now()
            });
        }
        
        return fingerprint;
    } catch (error) {
        throw new Error(`Failed to get fingerprint: ${error.message}`);
    }
}

/**
 * Récupère tous les fingerprints similaires (pour clustering)
 */
async function getSimilarFingerprints(fingerprintHash, limit = 10) {
    try {
        return await Fingerprint.find({ fingerprintHash })
            .sort({ 'history.lastSeen': -1 })
            .limit(limit)
            .lean();
    } catch (error) {
        throw new Error(`Failed to get similar fingerprints: ${error.message}`);
    }
}

/**
 * Récupère les fingerprints par identifiants HWID spécifiques
 */
async function getFingerprintsByHwid(hwidFields) {
    try {
        const query = {};
        
        if (hwidFields.smbiosUuid) {
            query['hwid.smbiosUuid'] = hwidFields.smbiosUuid;
        }
        if (hwidFields.diskSerial) {
            query['hwid.diskSerial'] = hwidFields.diskSerial;
        }
        if (hwidFields.baseboardSerial) {
            query['hwid.baseboardSerial'] = hwidFields.baseboardSerial;
        }
        if (hwidFields.machineGuid) {
            query['hwid.machineGuid'] = hwidFields.machineGuid;
        }
        
        return await Fingerprint.find(query)
            .sort({ 'history.lastSeen': -1 })
            .limit(20)
            .lean();
    } catch (error) {
        throw new Error(`Failed to get fingerprints by HWID: ${error.message}`);
    }
}

/**
 * Récupère les fingerprints par IP
 */
async function getFingerprintsByIp(ip, limit = 10) {
    try {
        return await Fingerprint.find({ 'network.ip': ip })
            .sort({ 'history.lastSeen': -1 })
            .limit(limit)
            .lean();
    } catch (error) {
        throw new Error(`Failed to get fingerprints by IP: ${error.message}`);
    }
}

/**
 * Détecte les changements entre deux fingerprints
 */
function detectChanges(oldHwid, newHwid) {
    const changes = [];
    const timestamp = new Date();
    
    const fieldsToCheck = [
        'smbiosUuid', 'diskSerial', 'baseboardSerial', 'biosVendor', 'biosVersion',
        'cpuModel', 'gpuVendor', 'gpuDevice', 'ramAmount', 'machineGuid'
    ];
    
    for (const field of fieldsToCheck) {
        const oldValue = oldHwid[field];
        const newValue = newHwid[field];
        
        if (oldValue && newValue && oldValue !== newValue) {
            changes.push({
                field,
                oldValue: String(oldValue),
                newValue: String(newValue),
                timestamp
            });
        }
    }
    
    return changes;
}

/**
 * Nettoie le cache (appelé périodiquement)
 */
function clearExpiredCache() {
    const now = Date.now();
    for (const [key, value] of fingerprintCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            fingerprintCache.delete(key);
        }
    }
}

// Nettoyer le cache toutes les 10 minutes
setInterval(clearExpiredCache, 10 * 60 * 1000);

module.exports = {
    saveFingerprint,
    getFingerprint,
    getSimilarFingerprints,
    getFingerprintsByHwid,
    getFingerprintsByIp,
    clearExpiredCache
};

/**
 * Database operations for ban records
 * Optimized with caching and batch operations
 */

const BanRecord = require('../../model/banrecord');
const Fingerprint = require('../../model/fingerprint');

// Cache pour les bans actifs (TTL: 10 minutes)
const banCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;

/**
 * Crée un nouveau ban record
 */
async function createBan(accountId, username, banData) {
    try {
        const {
            banType,
            reason,
            detailedReason,
            fingerprintHash,
            fingerprintSnapshot,
            scores,
            evidence,
            bannedBy = 'SYSTEM',
            moderatorId = null,
            permanent = true,
            expiresAt = null
        } = banData;
        
        // Compter les bans précédents
        const previousBans = await BanRecord.countDocuments({ accountId });
        const previousEvasions = await BanRecord.countDocuments({ 
            accountId, 
            banType: 'BAN_EVASION' 
        });
        
        const banRecord = new BanRecord({
            accountId,
            username,
            banType,
            reason,
            detailedReason,
            fingerprintHash,
            fingerprintSnapshot,
            scores,
            evidence,
            bannedBy,
            moderatorId,
            permanent,
            expiresAt,
            active: true,
            history: {
                previousBans,
                previousEvasions
            }
        });
        
        await banRecord.save();
        
        // Invalider le cache
        banCache.delete(accountId);
        banCache.delete(`hash:${fingerprintHash}`);
        
        return banRecord;
    } catch (error) {
        throw new Error(`Failed to create ban: ${error.message}`);
    }
}

/**
 * Vérifie si un compte est banni (avec cache)
 */
async function isAccountBanned(accountId) {
    try {
        // Vérifier le cache
        const cached = banCache.get(accountId);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return cached.data;
        }
        
        const ban = await BanRecord.findOne({ 
            accountId, 
            active: true,
            $or: [
                { permanent: true },
                { expiresAt: { $gt: new Date() } }
            ]
        }).sort({ createdAt: -1 });
        
        const isBanned = !!ban;
        
        // Mettre en cache
        banCache.set(accountId, {
            data: isBanned ? ban : null,
            timestamp: Date.now()
        });
        
        return isBanned ? ban : null;
    } catch (error) {
        throw new Error(`Failed to check ban status: ${error.message}`);
    }
}

/**
 * Récupère tous les bans actifs par fingerprint hash
 */
async function getBannedFingerprintsByHash(fingerprintHash) {
    try {
        // Vérifier le cache
        const cacheKey = `hash:${fingerprintHash}`;
        const cached = banCache.get(cacheKey);
        if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
            return cached.data;
        }
        
        const bans = await BanRecord.find({
            fingerprintHash,
            active: true,
            $or: [
                { permanent: true },
                { expiresAt: { $gt: new Date() } }
            ]
        }).lean();
        
        // Mettre en cache
        banCache.set(cacheKey, {
            data: bans,
            timestamp: Date.now()
        });
        
        return bans;
    } catch (error) {
        throw new Error(`Failed to get banned fingerprints: ${error.message}`);
    }
}

/**
 * Récupère tous les fingerprints bannis (pour comparaison)
 */
async function getAllBannedFingerprints() {
    try {
        const bans = await BanRecord.find({
            active: true,
            $or: [
                { permanent: true },
                { expiresAt: { $gt: new Date() } }
            ]
        }).select('accountId fingerprintHash fingerprintSnapshot').lean();
        
        // Récupérer les fingerprints complets
        const accountIds = bans.map(b => b.accountId);
        const fingerprints = await Fingerprint.find({
            accountId: { $in: accountIds }
        }).lean();
        
        return fingerprints;
    } catch (error) {
        throw new Error(`Failed to get all banned fingerprints: ${error.message}`);
    }
}

/**
 * Récupère les bans par identifiants HWID spécifiques
 */
async function getBansByHwid(hwidFields) {
    try {
        const query = { active: true };
        
        if (hwidFields.smbiosUuid) {
            query['fingerprintSnapshot.smbiosUuid'] = hwidFields.smbiosUuid;
        }
        if (hwidFields.diskSerial) {
            query['fingerprintSnapshot.diskSerial'] = hwidFields.diskSerial;
        }
        if (hwidFields.baseboardSerial) {
            query['fingerprintSnapshot.baseboardSerial'] = hwidFields.baseboardSerial;
        }
        if (hwidFields.machineGuid) {
            query['fingerprintSnapshot.machineGuid'] = hwidFields.machineGuid;
        }
        
        return await BanRecord.find(query)
            .sort({ createdAt: -1 })
            .limit(20)
            .lean();
    } catch (error) {
        throw new Error(`Failed to get bans by HWID: ${error.message}`);
    }
}

/**
 * Unban un compte
 */
async function unbanAccount(accountId, reason = null) {
    try {
        const result = await BanRecord.updateMany(
            { accountId, active: true },
            { 
                $set: { 
                    active: false,
                    appealReason: reason,
                    appealedAt: new Date()
                } 
            }
        );
        
        // Invalider le cache
        banCache.delete(accountId);
        
        return result.modifiedCount > 0;
    } catch (error) {
        throw new Error(`Failed to unban account: ${error.message}`);
    }
}

/**
 * Marque un webhook comme envoyé
 */
async function markWebhookSent(banId) {
    try {
        await BanRecord.updateOne(
            { _id: banId },
            { 
                $set: { 
                    webhookSent: true,
                    webhookSentAt: new Date()
                } 
            }
        );
    } catch (error) {
        throw new Error(`Failed to mark webhook sent: ${error.message}`);
    }
}

/**
 * Récupère les statistiques de bans
 */
async function getBanStats() {
    try {
        const [total, active, evasions, manual, automatic] = await Promise.all([
            BanRecord.countDocuments({}),
            BanRecord.countDocuments({ active: true }),
            BanRecord.countDocuments({ banType: 'BAN_EVASION', active: true }),
            BanRecord.countDocuments({ bannedBy: { $in: ['MODERATOR', 'ADMIN'] }, active: true }),
            BanRecord.countDocuments({ bannedBy: 'SYSTEM', active: true })
        ]);
        
        return {
            total,
            active,
            evasions,
            manual,
            automatic
        };
    } catch (error) {
        throw new Error(`Failed to get ban stats: ${error.message}`);
    }
}

/**
 * Nettoie les bans expirés
 */
async function cleanupExpiredBans() {
    try {
        const result = await BanRecord.updateMany(
            {
                active: true,
                permanent: false,
                expiresAt: { $lte: new Date() }
            },
            { $set: { active: false } }
        );
        
        // Vider le cache
        banCache.clear();
        
        return result.modifiedCount;
    } catch (error) {
        throw new Error(`Failed to cleanup expired bans: ${error.message}`);
    }
}

/**
 * Nettoie le cache expiré
 */
function clearExpiredCache() {
    const now = Date.now();
    for (const [key, value] of banCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            banCache.delete(key);
        }
    }
}

// Nettoyer le cache toutes les 10 minutes
setInterval(clearExpiredCache, 10 * 60 * 1000);

// Nettoyer les bans expirés toutes les heures
setInterval(cleanupExpiredBans, 60 * 60 * 1000);

module.exports = {
    createBan,
    isAccountBanned,
    getBannedFingerprintsByHash,
    getAllBannedFingerprints,
    getBansByHwid,
    unbanAccount,
    markWebhookSent,
    getBanStats,
    cleanupExpiredBans,
    clearExpiredCache
};

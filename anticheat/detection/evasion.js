/**
 * Ban evasion detection
 * Compare fingerprints avec les comptes bannis
 */

const { calculateMatchScore } = require('../scoring/calculator');
const { getBannedFingerprintsByHash, getBansByHwid, getAllBannedFingerprints } = require('../database/bans');
const weights = require('../scoring/weights');

/**
 * Détecte si un fingerprint correspond à un compte banni
 */
async function detectBanEvasion(fingerprint, accountId) {
    try {
        const results = {
            detected: false,
            confidence: 0,
            matches: [],
            reasons: []
        };
        
        // === 1. VÉRIFICATION PAR HASH EXACT ===
        const exactMatches = await getBannedFingerprintsByHash(fingerprint.fingerprintHash);
        
        if (exactMatches.length > 0) {
            results.detected = true;
            results.confidence = 95;
            results.matches.push(...exactMatches.map(ban => ({
                accountId: ban.accountId,
                matchScore: 100,
                reason: 'IDENTICAL_FINGERPRINT_HASH',
                banType: ban.banType,
                bannedAt: ban.createdAt
            })));
            results.reasons.push('Fingerprint hash matches banned account');
        }
        
        // === 2. VÉRIFICATION PAR IDENTIFIANTS FORTS ===
        const hwid = fingerprint.hwid;
        const hwidFields = {
            smbiosUuid: hwid.smbiosUuid,
            diskSerial: hwid.diskSerial,
            baseboardSerial: hwid.baseboardSerial,
            machineGuid: hwid.machineGuid
        };
        
        const hwidMatches = await getBansByHwid(hwidFields);
        
        for (const ban of hwidMatches) {
            const matchScore = calculatePartialHwidMatch(hwid, ban.fingerprintSnapshot);
            
            if (matchScore >= 70) {
                results.detected = true;
                results.confidence = Math.max(results.confidence, matchScore);
                results.matches.push({
                    accountId: ban.accountId,
                    matchScore,
                    reason: 'PARTIAL_HWID_MATCH',
                    banType: ban.banType,
                    bannedAt: ban.createdAt,
                    matchedFields: getMatchedFields(hwid, ban.fingerprintSnapshot)
                });
                results.reasons.push(`${matchScore}% HWID match with banned account`);
            }
        }
        
        // === 3. COMPARAISON AVEC TOUS LES BANS (si pas de match direct) ===
        if (!results.detected) {
            const allBannedFingerprints = await getAllBannedFingerprints();
            
            for (const bannedFp of allBannedFingerprints) {
                // Ignorer le même compte
                if (bannedFp.accountId === accountId) continue;
                
                const matchScore = calculateMatchScore(fingerprint, bannedFp);
                
                // Match partiel suspect
                if (matchScore >= 60 && matchScore < 95) {
                    results.detected = true;
                    results.confidence = Math.max(results.confidence, matchScore - 10);
                    results.matches.push({
                        accountId: bannedFp.accountId,
                        matchScore,
                        reason: 'SIMILAR_FINGERPRINT',
                        bannedAt: bannedFp.createdAt
                    });
                    results.reasons.push(`${matchScore}% similarity with banned fingerprint`);
                }
                
                // Limiter à 5 matches pour performance
                if (results.matches.length >= 5) break;
            }
        }
        
        // === 4. DÉTECTION DE SPOOF PARTIEL ===
        // Si certains identifiants forts matchent mais pas tous = probable spoof
        if (results.matches.length > 0) {
            const spoofIndicators = detectPartialSpoof(fingerprint, results.matches);
            if (spoofIndicators.length > 0) {
                results.confidence += 15;
                results.reasons.push(...spoofIndicators);
            }
        }
        
        // Limiter confidence à 100
        results.confidence = Math.min(100, results.confidence);
        
        return results;
    } catch (error) {
        throw new Error(`Ban evasion detection failed: ${error.message}`);
    }
}

/**
 * Calcule le score de match partiel HWID
 */
function calculatePartialHwidMatch(hwid1, hwid2) {
    let totalWeight = 0;
    let matchedWeight = 0;
    
    const comparisons = [
        { field: 'smbiosUuid', weight: weights.hwid.smbiosUuid },
        { field: 'diskSerial', weight: weights.hwid.diskSerial },
        { field: 'baseboardSerial', weight: weights.hwid.baseboardSerial },
        { field: 'machineGuid', weight: weights.hwid.machineGuid },
        { field: 'biosVendor', weight: weights.hwid.biosVendor },
        { field: 'cpuModel', weight: weights.hwid.cpuModel },
        { field: 'gpuDevice', weight: weights.hwid.gpuDevice }
    ];
    
    for (const comp of comparisons) {
        const val1 = hwid1[comp.field];
        const val2 = hwid2[comp.field];
        
        if (!val1 || !val2) continue;
        
        totalWeight += comp.weight;
        
        if (val1 === val2) {
            matchedWeight += comp.weight;
        }
    }
    
    if (totalWeight === 0) return 0;
    
    return Math.round((matchedWeight / totalWeight) * 100);
}

/**
 * Retourne les champs qui matchent
 */
function getMatchedFields(hwid1, hwid2) {
    const matched = [];
    
    const fields = [
        'smbiosUuid', 'diskSerial', 'baseboardSerial', 'machineGuid',
        'biosVendor', 'cpuModel', 'gpuDevice'
    ];
    
    for (const field of fields) {
        if (hwid1[field] && hwid2[field] && hwid1[field] === hwid2[field]) {
            matched.push(field);
        }
    }
    
    return matched;
}

/**
 * Détecte les indicateurs de spoof partiel
 */
function detectPartialSpoof(fingerprint, matches) {
    const indicators = [];
    
    for (const match of matches) {
        if (!match.matchedFields) continue;
        
        const matchedFields = match.matchedFields;
        
        // Si SMBIOS UUID match mais pas disk serial = suspect
        if (matchedFields.includes('smbiosUuid') && !matchedFields.includes('diskSerial')) {
            indicators.push('SMBIOS UUID matches but disk serial differs (possible spoof)');
        }
        
        // Si disk serial match mais pas SMBIOS = suspect
        if (matchedFields.includes('diskSerial') && !matchedFields.includes('smbiosUuid')) {
            indicators.push('Disk serial matches but SMBIOS UUID differs (possible spoof)');
        }
        
        // Si MachineGuid match mais identifiants hardware différents = suspect
        if (matchedFields.includes('machineGuid') && 
            !matchedFields.includes('smbiosUuid') && 
            !matchedFields.includes('diskSerial')) {
            indicators.push('MachineGuid matches but hardware IDs differ (possible spoof)');
        }
        
        // Si CPU/GPU matchent mais serials différents = upgrade hardware légitime
        if (matchedFields.includes('cpuModel') && 
            matchedFields.includes('gpuDevice') &&
            !matchedFields.includes('smbiosUuid')) {
            // Ceci est probablement légitime, ne pas ajouter d'indicateur
        }
    }
    
    return indicators;
}

/**
 * Vérifie si le changement est légitime (upgrade hardware)
 */
function isLegitimateChange(oldFingerprint, newFingerprint) {
    const oldHwid = oldFingerprint.hwid;
    const newHwid = newFingerprint.hwid;
    
    // Identifiants forts doivent rester identiques
    const strongIds = ['smbiosUuid', 'baseboardSerial'];
    const strongIdsMatch = strongIds.every(field => 
        !oldHwid[field] || !newHwid[field] || oldHwid[field] === newHwid[field]
    );
    
    if (!strongIdsMatch) {
        return false; // Changement suspect
    }
    
    // Vérifier les changements acceptables
    const changes = [];
    const acceptableChanges = ['gpuDevice', 'ramAmount', 'diskSerial', 'diskModel'];
    
    for (const field of acceptableChanges) {
        if (oldHwid[field] && newHwid[field] && oldHwid[field] !== newHwid[field]) {
            changes.push(field);
        }
    }
    
    // Si seulement des changements acceptables = légitime
    return changes.length > 0 && changes.length <= 2;
}

/**
 * Calcule le score d'évasion basé sur les patterns
 */
function calculateEvasionPattern(fingerprint, history) {
    let score = 0;
    
    // Changements fréquents d'IP
    if (history && history.ipHistory && history.ipHistory.length > 10) {
        const uniqueIps = new Set(history.ipHistory.map(h => h.ip)).size;
        if (uniqueIps > 5) {
            score += 20;
        }
    }
    
    // Changements fréquents de hardware
    if (history && history.changes && history.changes.length > 5) {
        const suspiciousChanges = history.changes.filter(c => 
            ['smbiosUuid', 'diskSerial', 'baseboardSerial', 'machineGuid'].includes(c.field)
        );
        
        if (suspiciousChanges.length > 2) {
            score += 30;
        }
    }
    
    // VPN + changements suspects
    if (fingerprint.network && fingerprint.network.isVpn && score > 0) {
        score += 15;
    }
    
    return Math.min(100, score);
}

module.exports = {
    detectBanEvasion,
    calculatePartialHwidMatch,
    isLegitimateChange,
    calculateEvasionPattern
};

const weights = require('./weights');
const crypto = require('crypto');

/**
 * Calcule le hash d'un fingerprint pour comparaison rapide
 */
function calculateFingerprintHash(hwid) {
    const components = [
        hwid.smbiosUuid,
        hwid.diskSerial,
        hwid.baseboardSerial,
        hwid.biosVendor,
        hwid.biosVersion,
        hwid.machineGuid,
        hwid.cpuModel,
        hwid.gpuDevice
    ].filter(Boolean).join('|');
    
    return crypto.createHash('sha256').update(components).digest('hex');
}

/**
 * Calcule le score de match entre deux fingerprints
 * Retourne un score de 0 à 100
 */
function calculateMatchScore(fp1, fp2) {
    let totalWeight = 0;
    let matchedWeight = 0;
    
    const hwid1 = fp1.hwid || fp1;
    const hwid2 = fp2.hwid || fp2;
    
    // Comparer les identifiants principaux
    const comparisons = [
        { field: 'smbiosUuid', weight: weights.hwid.smbiosUuid },
        { field: 'diskSerial', weight: weights.hwid.diskSerial },
        { field: 'baseboardSerial', weight: weights.hwid.baseboardSerial },
        { field: 'biosVendor', weight: weights.hwid.biosVendor },
        { field: 'biosVersion', weight: weights.hwid.biosVersion },
        { field: 'biosDate', weight: weights.hwid.biosDate },
        { field: 'diskModel', weight: weights.hwid.diskModel },
        { field: 'cpuModel', weight: weights.hwid.cpuModel },
        { field: 'gpuVendor', weight: weights.hwid.gpuVendor },
        { field: 'gpuDevice', weight: weights.hwid.gpuDevice },
        { field: 'machineGuid', weight: weights.hwid.machineGuid }
    ];
    
    for (const comp of comparisons) {
        const val1 = hwid1[comp.field];
        const val2 = hwid2[comp.field];
        
        // Ignorer si l'une des valeurs est nulle
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
 * Calcule le score de spoof (incohérences)
 * Retourne un score de 0 à 100 (plus élevé = plus suspect)
 */
function calculateSpoofScore(fingerprint) {
    let spoofScore = 0;
    const flags = [];
    
    const hwid = fingerprint.hwid;
    const sources = hwid.sources || {};
    
    // === VÉRIFICATION DES SOURCES ===
    const sourceCount = Object.values(sources).filter(Boolean).length;
    
    if (sourceCount === 0) {
        spoofScore += 50;
        flags.push('NO_COLLECTION_SOURCES');
    } else if (sourceCount === 1 && sources.wmi) {
        spoofScore += weights.sources.wmiOnly * -1; // Convertir en positif
        flags.push('WMI_ONLY_SOURCE');
    } else if (sourceCount >= 3) {
        spoofScore -= 10; // Bonus pour multiple sources
    }
    
    // === VALEURS NULLES / VIDES ===
    const criticalFields = ['smbiosUuid', 'diskSerial', 'baseboardSerial'];
    const nullCount = criticalFields.filter(field => !hwid[field]).length;
    
    if (nullCount >= 2) {
        spoofScore += weights.penalties.nullOrEmptySerial;
        flags.push('MULTIPLE_NULL_SERIALS');
    }
    
    // === VALEURS IMPOSSIBLES / SUSPECTES ===
    if (hwid.smbiosUuid && /^(0{8}-0{4}-0{4}-0{4}-0{12}|F{8}-F{4}-F{4}-F{4}-F{12})$/i.test(hwid.smbiosUuid)) {
        spoofScore += weights.penalties.impossibleValue;
        flags.push('INVALID_SMBIOS_UUID');
    }
    
    if (hwid.diskSerial && /^(0{8,}|1{8,}|X{8,})$/i.test(hwid.diskSerial)) {
        spoofScore += weights.penalties.impossibleValue;
        flags.push('INVALID_DISK_SERIAL');
    }
    
    // === PATTERNS SPOOFERS CONNUS ===
    const knownSpooferPatterns = [
        /DESKTOP-[A-Z0-9]{7}$/i,  // Pattern Windows générique
        /^To be filled by O\.E\.M\.$/i,
        /^Default string$/i,
        /^Not Specified$/i,
        /^System manufacturer$/i,
        /^System Product Name$/i
    ];
    
    const suspiciousValues = [
        hwid.biosVendor,
        hwid.baseboardSerial,
        hwid.diskModel
    ].filter(Boolean);
    
    for (const value of suspiciousValues) {
        if (knownSpooferPatterns.some(pattern => pattern.test(value))) {
            spoofScore += weights.penalties.knownSpooferPattern;
            flags.push('KNOWN_SPOOFER_PATTERN');
            break;
        }
    }
    
    // === VM / HYPERVISOR ===
    if (fingerprint.flags && fingerprint.flags.vmDetected) {
        spoofScore += weights.penalties.vmDetected;
        flags.push('VM_DETECTED');
    }
    
    // === INCOHÉRENCES RÉSEAU ===
    if (fingerprint.network) {
        if (fingerprint.network.isDatacenter) {
            spoofScore += weights.penalties.datacenterIp;
            flags.push('DATACENTER_IP');
        }
        
        if (fingerprint.network.isTor) {
            spoofScore += weights.penalties.torWithSuspiciousHwid;
            flags.push('TOR_NETWORK');
        }
        
        if (fingerprint.network.reputation < 30) {
            spoofScore += 15;
            flags.push('LOW_IP_REPUTATION');
        }
    }
    
    // Limiter le score entre 0 et 100
    spoofScore = Math.max(0, Math.min(100, spoofScore));
    
    return {
        score: Math.round(spoofScore),
        flags
    };
}

/**
 * Calcule le score de confiance (trust)
 * Retourne un score de 0 à 100 (plus élevé = plus fiable)
 */
function calculateTrustScore(fingerprint, history) {
    let trustScore = 50; // Base neutre
    
    const hwid = fingerprint.hwid;
    
    // === BONUS POUR IDENTIFIANTS FORTS ===
    if (hwid.smbiosUuid) trustScore += 10;
    if (hwid.diskSerial) trustScore += 10;
    if (hwid.baseboardSerial) trustScore += 8;
    if (hwid.tpmPresent) trustScore += weights.bonus.tpmPresent;
    if (hwid.secureBootEnabled) trustScore += weights.bonus.secureBootEnabled;
    
    // === BONUS POUR SOURCES MULTIPLES ===
    const sources = hwid.sources || {};
    const sourceCount = Object.values(sources).filter(Boolean).length;
    if (sourceCount >= 3) {
        trustScore += weights.bonus.allSourcesMatch;
    }
    
    // === HISTORIQUE ===
    if (history) {
        const accountAge = Date.now() - new Date(history.firstSeen).getTime();
        const daysOld = accountAge / (1000 * 60 * 60 * 24);
        
        if (daysOld > 30) {
            trustScore += weights.bonus.longAccountHistory;
        }
        
        if (history.seenCount > 10) {
            trustScore += 5;
        }
        
        // Pénalité pour changements fréquents
        if (history.changes && history.changes.length > 10) {
            trustScore -= 10;
        }
    }
    
    // === RÉSEAU ===
    if (fingerprint.network) {
        if (!fingerprint.network.isVpn && !fingerprint.network.isProxy) {
            trustScore += weights.bonus.legitimateIsp;
        }
        
        if (fingerprint.network.reputation > 70) {
            trustScore += 10;
        }
    }
    
    // === PÉNALITÉS ===
    if (fingerprint.flags) {
        if (fingerprint.flags.spoofDetected) trustScore -= 30;
        if (fingerprint.flags.vmDetected) trustScore -= 15;
        if (fingerprint.flags.inconsistencies && fingerprint.flags.inconsistencies.length > 0) {
            trustScore -= fingerprint.flags.inconsistencies.length * 5;
        }
    }
    
    // Limiter entre 0 et 100
    trustScore = Math.max(0, Math.min(100, trustScore));
    
    return Math.round(trustScore);
}

/**
 * Calcule le score d'évasion de ban
 * Compare avec les fingerprints bannis
 */
async function calculateEvasionScore(fingerprint, bannedFingerprints) {
    let evasionScore = 0;
    const relatedBans = [];
    
    for (const banned of bannedFingerprints) {
        const matchScore = calculateMatchScore(fingerprint, banned);
        
        // Match partiel avec un ban existant
        if (matchScore >= 50 && matchScore < 95) {
            evasionScore += 30;
            relatedBans.push({
                accountId: banned.accountId,
                matchScore,
                reason: 'PARTIAL_HWID_MATCH'
            });
        }
        
        // Match quasi-complet (probable spoof partiel)
        if (matchScore >= 70 && matchScore < 95) {
            evasionScore += 40;
            relatedBans.push({
                accountId: banned.accountId,
                matchScore,
                reason: 'HIGH_HWID_MATCH'
            });
        }
        
        // Match identique (même machine ou spoof raté)
        if (matchScore >= 95) {
            evasionScore += 60;
            relatedBans.push({
                accountId: banned.accountId,
                matchScore,
                reason: 'IDENTICAL_HWID'
            });
        }
    }
    
    // Limiter entre 0 et 100
    evasionScore = Math.max(0, Math.min(100, evasionScore));
    
    return {
        score: Math.round(evasionScore),
        relatedBans
    };
}

/**
 * Calcule le score final global
 */
function calculateFinalScore(scores) {
    const { match, spoof, trust, evasion } = scores;
    
    // Pondération des différents scores
    const weights = {
        trust: 0.35,
        spoof: 0.30,
        evasion: 0.25,
        match: 0.10
    };
    
    // Calcul inversé pour spoof (plus de spoof = score plus bas)
    const spoofInverted = 100 - spoof;
    
    // Calcul inversé pour evasion
    const evasionInverted = 100 - evasion;
    
    const finalScore = 
        (trust * weights.trust) +
        (spoofInverted * weights.spoof) +
        (evasionInverted * weights.evasion) +
        (match * weights.match);
    
    return Math.round(finalScore);
}

module.exports = {
    calculateFingerprintHash,
    calculateMatchScore,
    calculateSpoofScore,
    calculateTrustScore,
    calculateEvasionScore,
    calculateFinalScore
};

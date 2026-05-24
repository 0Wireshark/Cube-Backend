/**
 * Multi-account clustering detection
 * Détecte les comptes liés par similarité de fingerprints
 */

const { calculateMatchScore } = require('../scoring/calculator');
const { getFingerprintsByHwid, getFingerprintsByIp } = require('../database/fingerprints');

/**
 * Détecte les clusters de comptes (multi-accounting)
 */
async function detectAccountClusters(fingerprint, accountId) {
    try {
        const results = {
            detected: false,
            confidence: 0,
            clusters: [],
            relatedAccounts: []
        };
        
        // === 1. RECHERCHE PAR IDENTIFIANTS FORTS ===
        const hwid = fingerprint.hwid;
        const hwidMatches = await getFingerprintsByHwid({
            smbiosUuid: hwid.smbiosUuid,
            diskSerial: hwid.diskSerial,
            baseboardSerial: hwid.baseboardSerial,
            machineGuid: hwid.machineGuid
        });
        
        // Filtrer le compte actuel
        const otherAccounts = hwidMatches.filter(fp => fp.accountId !== accountId);
        
        if (otherAccounts.length > 0) {
            results.detected = true;
            results.confidence = 70;
            
            for (const otherFp of otherAccounts) {
                const matchScore = calculateMatchScore(fingerprint, otherFp);
                
                if (matchScore >= 80) {
                    results.relatedAccounts.push({
                        accountId: otherFp.accountId,
                        matchScore,
                        reason: 'IDENTICAL_HWID',
                        lastSeen: otherFp.history.lastSeen,
                        seenCount: otherFp.history.seenCount
                    });
                }
            }
        }
        
        // === 2. RECHERCHE PAR IP ===
        if (fingerprint.network && fingerprint.network.ip) {
            const ipMatches = await getFingerprintsByIp(fingerprint.network.ip);
            const otherIpAccounts = ipMatches.filter(fp => fp.accountId !== accountId);
            
            // IP partagée seule n'est pas suffisante, mais combinée avec HWID similaire = suspect
            for (const otherFp of otherIpAccounts) {
                const matchScore = calculateMatchScore(fingerprint, otherFp);
                
                if (matchScore >= 60 && matchScore < 80) {
                    // Vérifier si pas déjà ajouté
                    const alreadyAdded = results.relatedAccounts.some(
                        acc => acc.accountId === otherFp.accountId
                    );
                    
                    if (!alreadyAdded) {
                        results.detected = true;
                        results.confidence = Math.max(results.confidence, 50);
                        results.relatedAccounts.push({
                            accountId: otherFp.accountId,
                            matchScore,
                            reason: 'SAME_IP_SIMILAR_HWID',
                            lastSeen: otherFp.history.lastSeen,
                            seenCount: otherFp.history.seenCount
                        });
                    }
                }
            }
        }
        
        // === 3. ANALYSE DES CLUSTERS ===
        if (results.relatedAccounts.length > 0) {
            const cluster = analyzeCluster(results.relatedAccounts, fingerprint);
            results.clusters.push(cluster);
            
            // Ajuster confidence basé sur le cluster
            if (cluster.size >= 5) {
                results.confidence = Math.min(100, results.confidence + 20);
            } else if (cluster.size >= 3) {
                results.confidence = Math.min(100, results.confidence + 10);
            }
        }
        
        return results;
    } catch (error) {
        throw new Error(`Account clustering detection failed: ${error.message}`);
    }
}

/**
 * Analyse un cluster de comptes
 */
function analyzeCluster(relatedAccounts, fingerprint) {
    const cluster = {
        id: generateClusterId(fingerprint),
        size: relatedAccounts.length + 1, // +1 pour le compte actuel
        accounts: relatedAccounts.map(acc => acc.accountId),
        avgMatchScore: 0,
        creationPattern: null,
        suspicionLevel: 'LOW'
    };
    
    // Calculer le score moyen
    const totalScore = relatedAccounts.reduce((sum, acc) => sum + acc.matchScore, 0);
    cluster.avgMatchScore = Math.round(totalScore / relatedAccounts.length);
    
    // Analyser les patterns de création
    const lastSeenDates = relatedAccounts.map(acc => new Date(acc.lastSeen));
    cluster.creationPattern = analyzeCreationPattern(lastSeenDates);
    
    // Déterminer le niveau de suspicion
    if (cluster.size >= 5 && cluster.avgMatchScore >= 90) {
        cluster.suspicionLevel = 'CRITICAL';
    } else if (cluster.size >= 3 && cluster.avgMatchScore >= 80) {
        cluster.suspicionLevel = 'HIGH';
    } else if (cluster.size >= 2 && cluster.avgMatchScore >= 70) {
        cluster.suspicionLevel = 'MEDIUM';
    }
    
    return cluster;
}

/**
 * Génère un ID unique pour un cluster
 */
function generateClusterId(fingerprint) {
    const crypto = require('crypto');
    const components = [
        fingerprint.hwid.smbiosUuid,
        fingerprint.hwid.diskSerial,
        fingerprint.hwid.baseboardSerial
    ].filter(Boolean).join('|');
    
    return crypto.createHash('md5').update(components).digest('hex').substring(0, 16);
}

/**
 * Analyse les patterns de création de comptes
 */
function analyzeCreationPattern(dates) {
    if (dates.length < 2) {
        return { type: 'SINGLE', suspicious: false };
    }
    
    // Trier les dates
    dates.sort((a, b) => a - b);
    
    // Calculer les intervalles entre créations
    const intervals = [];
    for (let i = 1; i < dates.length; i++) {
        const diff = dates[i] - dates[i - 1];
        intervals.push(diff / (1000 * 60 * 60)); // En heures
    }
    
    // Créations rapides (< 24h entre chaque)
    const rapidCreations = intervals.filter(interval => interval < 24).length;
    if (rapidCreations >= 2) {
        return {
            type: 'RAPID_CREATION',
            suspicious: true,
            avgInterval: Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length)
        };
    }
    
    // Créations régulières (pattern suspect)
    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((sum, interval) => {
        return sum + Math.pow(interval - avgInterval, 2);
    }, 0) / intervals.length;
    
    // Faible variance = pattern régulier = suspect
    if (variance < 10 && intervals.length >= 3) {
        return {
            type: 'REGULAR_PATTERN',
            suspicious: true,
            avgInterval: Math.round(avgInterval)
        };
    }
    
    return {
        type: 'NORMAL',
        suspicious: false,
        avgInterval: Math.round(avgInterval)
    };
}

/**
 * Détecte les comptes "farm" (beaucoup de comptes, peu d'activité)
 */
function detectFarmAccounts(relatedAccounts) {
    const results = {
        detected: false,
        confidence: 0,
        indicators: []
    };
    
    // Beaucoup de comptes avec peu d'activité chacun
    const lowActivityAccounts = relatedAccounts.filter(acc => acc.seenCount < 5);
    
    if (lowActivityAccounts.length >= 3 && lowActivityAccounts.length === relatedAccounts.length) {
        results.detected = true;
        results.confidence = 60;
        results.indicators.push(`${lowActivityAccounts.length} accounts with low activity`);
    }
    
    // Tous les comptes créés récemment
    const recentAccounts = relatedAccounts.filter(acc => {
        const daysSinceLastSeen = (Date.now() - new Date(acc.lastSeen)) / (1000 * 60 * 60 * 24);
        return daysSinceLastSeen < 7;
    });
    
    if (recentAccounts.length >= 3) {
        results.detected = true;
        results.confidence = Math.max(results.confidence, 50);
        results.indicators.push(`${recentAccounts.length} recently active accounts`);
    }
    
    return results;
}

/**
 * Calcule le score de risque multi-account
 */
function calculateMultiAccountRisk(clusterResults) {
    let riskScore = 0;
    
    if (!clusterResults.detected) {
        return 0;
    }
    
    // Nombre de comptes liés
    const accountCount = clusterResults.relatedAccounts.length;
    if (accountCount >= 5) {
        riskScore += 40;
    } else if (accountCount >= 3) {
        riskScore += 25;
    } else if (accountCount >= 2) {
        riskScore += 15;
    }
    
    // Score de match moyen
    if (clusterResults.clusters.length > 0) {
        const avgMatch = clusterResults.clusters[0].avgMatchScore;
        if (avgMatch >= 90) {
            riskScore += 30;
        } else if (avgMatch >= 80) {
            riskScore += 20;
        } else if (avgMatch >= 70) {
            riskScore += 10;
        }
    }
    
    // Pattern de création suspect
    if (clusterResults.clusters.length > 0) {
        const pattern = clusterResults.clusters[0].creationPattern;
        if (pattern && pattern.suspicious) {
            riskScore += 20;
        }
    }
    
    return Math.min(100, riskScore);
}

module.exports = {
    detectAccountClusters,
    analyzeCluster,
    detectFarmAccounts,
    calculateMultiAccountRisk
};

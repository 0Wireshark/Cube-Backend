const weights = require('./weights');

/**
 * Décisions possibles du système
 */
const DECISIONS = {
    ALLOW: 'ALLOW',                     // Autoriser la connexion
    ALLOW_MONITOR: 'ALLOW_MONITOR',     // Autoriser mais surveiller
    SUSPICIOUS: 'SUSPICIOUS',           // Suspect, log détaillé
    REVIEW_REQUIRED: 'REVIEW_REQUIRED', // Review manuelle requise
    DENY: 'DENY',                       // Refuser la connexion
    BAN: 'BAN'                          // Ban permanent
};

/**
 * Niveaux de sévérité pour les webhooks
 */
const SEVERITY = {
    INFO: 'INFO',
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
    CRITICAL: 'CRITICAL'
};

/**
 * Détermine la décision finale basée sur les scores
 */
function makeDecision(scores, flags, relatedBans) {
    const { final, spoof, trust, evasion } = scores;
    
    // === BAN AUTOMATIQUE ===
    
    // Ban evasion quasi certain
    if (evasion >= weights.thresholds.evasion.certain) {
        return {
            decision: DECISIONS.BAN,
            reason: 'BAN_EVASION_DETECTED',
            severity: SEVERITY.CRITICAL,
            autoban: true,
            confidence: 95,
            details: 'Fingerprint matches banned account with high confidence'
        };
    }
    
    // Spoof critique + ban evasion probable
    if (spoof >= weights.thresholds.spoof.critical && evasion >= weights.thresholds.evasion.high) {
        return {
            decision: DECISIONS.BAN,
            reason: 'SPOOF_AND_EVASION',
            severity: SEVERITY.CRITICAL,
            autoban: true,
            confidence: 90,
            details: 'Critical spoofing detected with probable ban evasion'
        };
    }
    
    // Score final très bas (machine non fiable)
    if (final <= weights.thresholds.final.ban) {
        return {
            decision: DECISIONS.BAN,
            reason: 'UNTRUSTED_MACHINE',
            severity: SEVERITY.CRITICAL,
            autoban: true,
            confidence: 85,
            details: 'Machine trust score below ban threshold'
        };
    }
    
    // === REVIEW MANUELLE REQUISE ===
    
    // Ban evasion très probable
    if (evasion >= weights.thresholds.evasion.veryHigh) {
        return {
            decision: DECISIONS.REVIEW_REQUIRED,
            reason: 'PROBABLE_BAN_EVASION',
            severity: SEVERITY.HIGH,
            autoban: false,
            confidence: 75,
            details: 'High probability of ban evasion, manual review recommended',
            relatedBans: relatedBans.slice(0, 3) // Top 3 matches
        };
    }
    
    // Spoof élevé
    if (spoof >= weights.thresholds.spoof.high) {
        return {
            decision: DECISIONS.REVIEW_REQUIRED,
            reason: 'HIGH_SPOOF_SCORE',
            severity: SEVERITY.HIGH,
            autoban: false,
            confidence: 70,
            details: 'High spoofing score detected, manual review recommended',
            flags: flags
        };
    }
    
    // Score final dans la zone de review
    if (final >= weights.thresholds.final.ban && final < weights.thresholds.final.review) {
        return {
            decision: DECISIONS.REVIEW_REQUIRED,
            reason: 'LOW_TRUST_SCORE',
            severity: SEVERITY.MEDIUM,
            autoban: false,
            confidence: 60,
            details: 'Trust score in review range'
        };
    }
    
    // === REFUS TEMPORAIRE ===
    
    // Suspect mais pas assez pour ban
    if (final >= weights.thresholds.final.review && final < weights.thresholds.final.suspicious) {
        return {
            decision: DECISIONS.DENY,
            reason: 'SUSPICIOUS_ACTIVITY',
            severity: SEVERITY.MEDIUM,
            autoban: false,
            confidence: 50,
            details: 'Suspicious activity detected, connection denied temporarily'
        };
    }
    
    // === SURVEILLANCE ===
    
    // Légèrement suspect
    if (spoof >= weights.thresholds.spoof.medium || evasion >= weights.thresholds.evasion.medium) {
        return {
            decision: DECISIONS.SUSPICIOUS,
            reason: 'MODERATE_SUSPICION',
            severity: SEVERITY.LOW,
            autoban: false,
            confidence: 40,
            details: 'Moderate suspicion, monitoring enabled'
        };
    }
    
    // Confiance moyenne, surveiller
    if (trust < weights.thresholds.trust.normal) {
        return {
            decision: DECISIONS.ALLOW_MONITOR,
            reason: 'BELOW_NORMAL_TRUST',
            severity: SEVERITY.LOW,
            autoban: false,
            confidence: 30,
            details: 'Trust below normal, monitoring enabled'
        };
    }
    
    // === AUTORISER ===
    
    return {
        decision: DECISIONS.ALLOW,
        reason: 'TRUSTED',
        severity: SEVERITY.INFO,
        autoban: false,
        confidence: 100,
        details: 'Machine trusted, connection allowed'
    };
}

/**
 * Détermine si un webhook doit être envoyé
 */
function shouldSendWebhook(decision) {
    const webhookTriggers = [
        DECISIONS.BAN,
        DECISIONS.REVIEW_REQUIRED
    ];
    
    return webhookTriggers.includes(decision.decision);
}

/**
 * Détermine si l'événement doit être loggé en détail
 */
function shouldLogDetailed(decision) {
    const detailedLogTriggers = [
        DECISIONS.BAN,
        DECISIONS.REVIEW_REQUIRED,
        DECISIONS.DENY,
        DECISIONS.SUSPICIOUS
    ];
    
    return detailedLogTriggers.includes(decision.decision);
}

/**
 * Génère un résumé lisible de la décision
 */
function generateDecisionSummary(decision, scores, accountId) {
    const summary = {
        accountId,
        decision: decision.decision,
        reason: decision.reason,
        severity: decision.severity,
        confidence: decision.confidence,
        autoban: decision.autoban,
        scores: {
            final: scores.final,
            trust: scores.trust,
            spoof: scores.spoof,
            evasion: scores.evasion
        },
        timestamp: new Date().toISOString()
    };
    
    if (decision.relatedBans) {
        summary.relatedBans = decision.relatedBans.length;
    }
    
    if (decision.flags) {
        summary.flags = decision.flags;
    }
    
    return summary;
}

/**
 * Vérifie si une action doit être prise immédiatement
 */
function requiresImmediateAction(decision) {
    return decision.decision === DECISIONS.BAN || decision.decision === DECISIONS.DENY;
}

/**
 * Calcule le délai avant la prochaine vérification (en secondes)
 */
function getNextCheckDelay(decision) {
    switch (decision.decision) {
        case DECISIONS.ALLOW:
            return 86400; // 24 heures
        case DECISIONS.ALLOW_MONITOR:
            return 3600; // 1 heure
        case DECISIONS.SUSPICIOUS:
            return 1800; // 30 minutes
        case DECISIONS.REVIEW_REQUIRED:
            return 600; // 10 minutes
        case DECISIONS.DENY:
            return 300; // 5 minutes
        case DECISIONS.BAN:
            return null; // Pas de prochaine vérification
        default:
            return 3600;
    }
}

module.exports = {
    DECISIONS,
    SEVERITY,
    makeDecision,
    shouldSendWebhook,
    shouldLogDetailed,
    generateDecisionSummary,
    requiresImmediateAction,
    getNextCheckDelay
};

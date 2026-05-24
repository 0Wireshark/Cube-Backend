/**
 * CUBE Anti-Cheat System - Main Entry Point
 * Professional ban evasion and spoofing detection
 */

const log = require('../structs/log.js');

// Scoring
const { 
    calculateFingerprintHash,
    calculateMatchScore,
    calculateSpoofScore,
    calculateTrustScore,
    calculateEvasionScore,
    calculateFinalScore
} = require('./scoring/calculator');

const {
    makeDecision,
    shouldSendWebhook,
    shouldLogDetailed,
    generateDecisionSummary
} = require('./scoring/decision');

// Detection
const { detectBanEvasion } = require('./detection/evasion');
const { detectAdvancedSpoof } = require('./detection/spoof');
const { detectAccountClusters } = require('./detection/clustering');

// Network
const { validateNetwork } = require('./network/validator');

// Database
const { saveFingerprint, getFingerprint } = require('./database/fingerprints');
const { 
    isAccountBanned, 
    createBan, 
    getAllBannedFingerprints 
} = require('./database/bans');

// Webhooks
const {
    sendBanWebhook,
    sendBanEvasionWebhook,
    sendSpoofWebhook,
    sendReviewWebhook,
    sendMultiAccountWebhook
} = require('./webhooks/discord');

/**
 * Vérifie un joueur au login (fonction principale)
 */
async function verifyPlayer(accountId, username, fingerprintData, ip) {
    try {
        log.debug(`[AntiCheat] Verifying player: ${username} (${accountId})`);
        
        const startTime = Date.now();
        
        // === 1. VÉRIFIER SI DÉJÀ BANNI ===
        const existingBan = await isAccountBanned(accountId);
        if (existingBan) {
            log.debug(`[AntiCheat] Account ${accountId} is already banned`);
            return {
                allowed: false,
                decision: 'BAN',
                reason: 'ALREADY_BANNED',
                banRecord: existingBan
            };
        }
        
        // === 2. VALIDER LE RÉSEAU ===
        const networkInfo = await validateNetwork(ip);
        fingerprintData.network = networkInfo;
        
        // === 3. CALCULER LE HASH DU FINGERPRINT ===
        const fingerprintHash = calculateFingerprintHash(fingerprintData.hwid);
        fingerprintData.fingerprintHash = fingerprintHash;
        
        // === 4. RÉCUPÉRER L'HISTORIQUE ===
        const existingFingerprint = await getFingerprint(accountId);
        const history = existingFingerprint ? existingFingerprint.history : null;
        
        // === 5. DÉTECTION SPOOF ===
        const spoofResult = detectAdvancedSpoof(fingerprintData);
        const spoofScore = spoofResult.confidence;
        
        // === 6. DÉTECTION BAN EVASION ===
        const bannedFingerprints = await getAllBannedFingerprints();
        const evasionResult = await detectBanEvasion(fingerprintData, accountId);
        const evasionScoreCalc = await calculateEvasionScore(fingerprintData, bannedFingerprints);
        const evasionScore = Math.max(evasionResult.confidence, evasionScoreCalc.score);
        
        // === 7. DÉTECTION MULTI-ACCOUNT ===
        const clusterResult = await detectAccountClusters(fingerprintData, accountId);
        
        // === 8. CALCULER LES SCORES ===
        const trustScore = calculateTrustScore(fingerprintData, history);
        const matchScore = existingFingerprint ? 
            calculateMatchScore(fingerprintData, existingFingerprint) : 0;
        
        const scores = {
            match: matchScore,
            spoof: spoofScore,
            trust: trustScore,
            evasion: evasionScore,
            final: 0
        };
        
        scores.final = calculateFinalScore(scores);
        
        // === 9. PRENDRE LA DÉCISION ===
        const relatedBans = evasionResult.matches || [];
        const decision = makeDecision(scores, spoofResult.flags, relatedBans);
        
        // === 10. SAUVEGARDER LE FINGERPRINT ===
        const flags = {
            spoofDetected: spoofResult.detected,
            vmDetected: spoofResult.flags.includes('VM_DETECTED'),
            inconsistencies: spoofResult.indicators,
            suspiciousPatterns: []
        };
        
        await saveFingerprint(accountId, fingerprintData, scores, flags);
        
        // === 11. ACTIONS SELON LA DÉCISION ===
        let banRecord = null;
        
        if (decision.decision === 'BAN') {
            // Créer le ban
            banRecord = await createBan(accountId, username, {
                banType: decision.reason === 'BAN_EVASION_DETECTED' ? 'BAN_EVASION' : 
                         decision.reason === 'SPOOF_AND_EVASION' ? 'SPOOF' : 'AUTOMATIC',
                reason: decision.reason,
                detailedReason: decision.details,
                fingerprintHash,
                fingerprintSnapshot: {
                    smbiosUuid: fingerprintData.hwid.smbiosUuid,
                    diskSerial: fingerprintData.hwid.diskSerial,
                    baseboardSerial: fingerprintData.hwid.baseboardSerial,
                    machineGuid: fingerprintData.hwid.machineGuid,
                    ip: networkInfo.ip,
                    asn: networkInfo.asn
                },
                scores,
                evidence: {
                    flags: spoofResult.flags,
                    inconsistencies: spoofResult.indicators,
                    relatedAccounts: clusterResult.relatedAccounts.map(acc => acc.accountId),
                    clusterIds: clusterResult.clusters.map(c => c.id)
                },
                bannedBy: 'SYSTEM',
                permanent: true
            });
            
            // Envoyer webhook
            if (shouldSendWebhook(decision)) {
                await sendBanWebhook({
                    accountId,
                    username,
                    reason: decision.reason,
                    detailedReason: decision.details,
                    scores,
                    evidence: {
                        flags: spoofResult.flags
                    },
                    banType: banRecord.banType
                });
            }
            
            log.debug(`[AntiCheat] Account ${accountId} banned: ${decision.reason}`);
        }
        
        // === 12. WEBHOOKS POUR AUTRES ÉVÉNEMENTS ===
        if (decision.decision === 'REVIEW_REQUIRED' && shouldSendWebhook(decision)) {
            await sendReviewWebhook({
                accountId,
                username,
                reason: decision.reason,
                scores,
                details: decision.details
            });
        }
        
        if (evasionResult.detected && evasionResult.confidence >= 75) {
            await sendBanEvasionWebhook({
                accountId,
                username,
                confidence: evasionResult.confidence,
                matches: evasionResult.matches,
                relatedBans
            });
        }
        
        if (spoofResult.detected && spoofResult.confidence >= 70) {
            await sendSpoofWebhook({
                accountId,
                username,
                confidence: spoofResult.confidence,
                indicators: spoofResult.indicators,
                flags: spoofResult.flags
            });
        }
        
        if (clusterResult.detected && clusterResult.relatedAccounts.length >= 3) {
            await sendMultiAccountWebhook({
                accountId,
                username,
                clusterSize: clusterResult.relatedAccounts.length + 1,
                relatedAccounts: clusterResult.relatedAccounts
            });
        }
        
        // === 13. LOGGING ===
        if (shouldLogDetailed(decision)) {
            const summary = generateDecisionSummary(decision, scores, accountId);
            log.debug(`[AntiCheat] Decision: ${JSON.stringify(summary)}`);
        }
        
        const processingTime = Date.now() - startTime;
        log.debug(`[AntiCheat] Verification completed in ${processingTime}ms`);
        
        // === 14. RETOURNER LE RÉSULTAT ===
        return {
            allowed: decision.decision === 'ALLOW' || decision.decision === 'ALLOW_MONITOR',
            decision: decision.decision,
            reason: decision.reason,
            confidence: decision.confidence,
            scores,
            spoofDetected: spoofResult.detected,
            evasionDetected: evasionResult.detected,
            clusterDetected: clusterResult.detected,
            networkSuspicious: networkInfo.riskScore > 50,
            banRecord,
            processingTime
        };
        
    } catch (error) {
        log.error(`[AntiCheat] Verification failed for ${accountId}: ${error.message}`);
        
        // En cas d'erreur, autoriser par défaut (fail-open)
        return {
            allowed: true,
            decision: 'ALLOW',
            reason: 'VERIFICATION_ERROR',
            error: error.message
        };
    }
}

/**
 * Vérifie rapidement si un compte est banni (pour performance)
 */
async function quickBanCheck(accountId) {
    try {
        const ban = await isAccountBanned(accountId);
        return {
            banned: !!ban,
            banRecord: ban
        };
    } catch (error) {
        log.error(`[AntiCheat] Quick ban check failed: ${error.message}`);
        return {
            banned: false,
            error: error.message
        };
    }
}

/**
 * Vérifie un fingerprint sans sauvegarder (pour preview)
 */
async function previewFingerprint(fingerprintData, ip) {
    try {
        // Valider le réseau
        const networkInfo = await validateNetwork(ip);
        fingerprintData.network = networkInfo;
        
        // Détection spoof
        const spoofResult = detectAdvancedSpoof(fingerprintData);
        
        // Calculer les scores
        const trustScore = calculateTrustScore(fingerprintData, null);
        const spoofScore = spoofResult.confidence;
        
        const scores = {
            match: 0,
            spoof: spoofScore,
            trust: trustScore,
            evasion: 0,
            final: 0
        };
        
        scores.final = calculateFinalScore(scores);
        
        return {
            scores,
            spoofDetected: spoofResult.detected,
            spoofIndicators: spoofResult.indicators,
            spoofFlags: spoofResult.flags,
            networkInfo
        };
    } catch (error) {
        throw new Error(`Fingerprint preview failed: ${error.message}`);
    }
}

module.exports = {
    verifyPlayer,
    quickBanCheck,
    previewFingerprint
};

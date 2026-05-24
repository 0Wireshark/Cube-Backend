/**
 * Discord webhook system optimisé
 * Batching, rate limiting, severity filtering
 */

const axios = require('axios');
const config = require('../../structs/config.js');
const log = require('../../structs/log.js');

// Queue pour batching
const webhookQueue = [];
const BATCH_INTERVAL = 30000; // 30 secondes
const MAX_BATCH_SIZE = 10;
const RATE_LIMIT_DELAY = 2000; // 2 secondes entre webhooks

// Dernière fois qu'un webhook a été envoyé
let lastWebhookTime = 0;

// Statistiques
const stats = {
    sent: 0,
    failed: 0,
    batched: 0,
    dropped: 0
};

/**
 * Envoie un webhook Discord (avec batching et rate limiting)
 */
async function sendWebhook(webhookData) {
    try {
        // Vérifier si les webhooks sont activés
        if (!config.anticheat || !config.anticheat.webhooks || !config.anticheat.webhooks.enabled) {
            log.debug('Anti-cheat webhooks disabled');
            return false;
        }
        
        const webhookUrl = config.anticheat.webhooks.url;
        if (!webhookUrl || webhookUrl.trim() === '') {
            log.debug('Anti-cheat webhook URL not configured');
            return false;
        }
        
        // Vérifier la sévérité minimale
        const minSeverity = config.anticheat.webhooks.minSeverity || 'HIGH';
        if (!shouldSendBySeverity(webhookData.severity, minSeverity)) {
            log.debug(`Webhook dropped: severity ${webhookData.severity} below minimum ${minSeverity}`);
            stats.dropped++;
            return false;
        }
        
        // Ajouter à la queue
        webhookQueue.push({
            ...webhookData,
            timestamp: new Date().toISOString()
        });
        
        // Si la queue est pleine, envoyer immédiatement
        if (webhookQueue.length >= MAX_BATCH_SIZE) {
            await flushWebhookQueue();
        }
        
        return true;
    } catch (error) {
        log.error(`Failed to queue webhook: ${error.message}`);
        stats.failed++;
        return false;
    }
}

/**
 * Envoie un webhook pour un ban
 */
async function sendBanWebhook(banData) {
    const { accountId, username, reason, detailedReason, scores, evidence, banType } = banData;
    
    const embed = {
        title: '🚫 Account Banned',
        color: 0xFF0000, // Rouge
        fields: [
            {
                name: 'Account',
                value: `${username} (${accountId})`,
                inline: true
            },
            {
                name: 'Ban Type',
                value: banType,
                inline: true
            },
            {
                name: 'Reason',
                value: reason,
                inline: false
            }
        ],
        timestamp: new Date().toISOString()
    };
    
    if (detailedReason) {
        embed.fields.push({
            name: 'Details',
            value: detailedReason.substring(0, 1024),
            inline: false
        });
    }
    
    if (scores) {
        embed.fields.push({
            name: 'Scores',
            value: `Trust: ${scores.trust} | Spoof: ${scores.spoof} | Evasion: ${scores.evasion} | Final: ${scores.final}`,
            inline: false
        });
    }
    
    if (evidence && evidence.flags && evidence.flags.length > 0) {
        embed.fields.push({
            name: 'Flags',
            value: evidence.flags.slice(0, 5).join(', '),
            inline: false
        });
    }
    
    return await sendWebhook({
        type: 'BAN',
        severity: 'CRITICAL',
        embeds: [embed]
    });
}

/**
 * Envoie un webhook pour ban evasion
 */
async function sendBanEvasionWebhook(evasionData) {
    const { accountId, username, confidence, matches, relatedBans } = evasionData;
    
    const embed = {
        title: '⚠️ Ban Evasion Detected',
        color: 0xFF6600, // Orange
        fields: [
            {
                name: 'Account',
                value: `${username} (${accountId})`,
                inline: true
            },
            {
                name: 'Confidence',
                value: `${confidence}%`,
                inline: true
            },
            {
                name: 'Related Bans',
                value: `${matches.length} account(s)`,
                inline: true
            }
        ],
        timestamp: new Date().toISOString()
    };
    
    if (matches.length > 0) {
        const matchList = matches.slice(0, 3).map(m => 
            `• ${m.accountId} (${m.matchScore}% match)`
        ).join('\n');
        
        embed.fields.push({
            name: 'Matches',
            value: matchList,
            inline: false
        });
    }
    
    return await sendWebhook({
        type: 'BAN_EVASION',
        severity: 'CRITICAL',
        embeds: [embed]
    });
}

/**
 * Envoie un webhook pour spoofing détecté
 */
async function sendSpoofWebhook(spoofData) {
    const { accountId, username, confidence, indicators, flags } = spoofData;
    
    const embed = {
        title: '🔍 Spoofing Detected',
        color: 0xFFAA00, // Jaune-orange
        fields: [
            {
                name: 'Account',
                value: `${username} (${accountId})`,
                inline: true
            },
            {
                name: 'Confidence',
                value: `${confidence}%`,
                inline: true
            },
            {
                name: 'Flags',
                value: flags.slice(0, 3).join(', ') || 'None',
                inline: false
            }
        ],
        timestamp: new Date().toISOString()
    };
    
    if (indicators.length > 0) {
        embed.fields.push({
            name: 'Indicators',
            value: indicators.slice(0, 5).join('\n').substring(0, 1024),
            inline: false
        });
    }
    
    return await sendWebhook({
        type: 'SPOOF',
        severity: confidence >= 80 ? 'HIGH' : 'MEDIUM',
        embeds: [embed]
    });
}

/**
 * Envoie un webhook pour review manuelle requise
 */
async function sendReviewWebhook(reviewData) {
    const { accountId, username, reason, scores, details } = reviewData;
    
    const embed = {
        title: '👁️ Manual Review Required',
        color: 0xFFFF00, // Jaune
        fields: [
            {
                name: 'Account',
                value: `${username} (${accountId})`,
                inline: true
            },
            {
                name: 'Reason',
                value: reason,
                inline: true
            }
        ],
        timestamp: new Date().toISOString()
    };
    
    if (scores) {
        embed.fields.push({
            name: 'Scores',
            value: `Trust: ${scores.trust} | Spoof: ${scores.spoof} | Evasion: ${scores.evasion}`,
            inline: false
        });
    }
    
    if (details) {
        embed.fields.push({
            name: 'Details',
            value: details.substring(0, 1024),
            inline: false
        });
    }
    
    return await sendWebhook({
        type: 'REVIEW',
        severity: 'HIGH',
        embeds: [embed]
    });
}

/**
 * Envoie un webhook pour multi-account détecté
 */
async function sendMultiAccountWebhook(clusterData) {
    const { accountId, username, clusterSize, relatedAccounts } = clusterData;
    
    const embed = {
        title: '👥 Multi-Account Cluster Detected',
        color: 0xFF9900, // Orange
        fields: [
            {
                name: 'Account',
                value: `${username} (${accountId})`,
                inline: true
            },
            {
                name: 'Cluster Size',
                value: `${clusterSize} accounts`,
                inline: true
            }
        ],
        timestamp: new Date().toISOString()
    };
    
    if (relatedAccounts && relatedAccounts.length > 0) {
        const accountList = relatedAccounts.slice(0, 5).map(acc => 
            `• ${acc.accountId} (${acc.matchScore}%)`
        ).join('\n');
        
        embed.fields.push({
            name: 'Related Accounts',
            value: accountList,
            inline: false
        });
    }
    
    return await sendWebhook({
        type: 'MULTI_ACCOUNT',
        severity: clusterSize >= 5 ? 'HIGH' : 'MEDIUM',
        embeds: [embed]
    });
}

/**
 * Flush la queue de webhooks (envoie en batch)
 */
async function flushWebhookQueue() {
    if (webhookQueue.length === 0) return;
    
    try {
        const webhookUrl = config.anticheat.webhooks.url;
        
        // Respecter le rate limit
        const now = Date.now();
        const timeSinceLastWebhook = now - lastWebhookTime;
        if (timeSinceLastWebhook < RATE_LIMIT_DELAY) {
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY - timeSinceLastWebhook));
        }
        
        // Prendre les webhooks de la queue
        const batch = webhookQueue.splice(0, MAX_BATCH_SIZE);
        
        if (batch.length === 1) {
            // Envoyer un seul webhook
            await axios.post(webhookUrl, {
                username: 'CUBE Anti-Cheat',
                avatar_url: 'https://i.imgur.com/jhUfbwy.png',
                embeds: batch[0].embeds
            });
            
            stats.sent++;
        } else {
            // Envoyer un webhook groupé
            const summaryEmbed = {
                title: `📊 Anti-Cheat Summary (${batch.length} events)`,
                color: 0x00AAFF,
                fields: [],
                timestamp: new Date().toISOString()
            };
            
            // Grouper par type
            const grouped = {};
            for (const item of batch) {
                grouped[item.type] = (grouped[item.type] || 0) + 1;
            }
            
            for (const [type, count] of Object.entries(grouped)) {
                summaryEmbed.fields.push({
                    name: type,
                    value: `${count} event(s)`,
                    inline: true
                });
            }
            
            // Ajouter les 3 premiers événements en détail
            const detailEmbeds = batch.slice(0, 3).map(item => item.embeds[0]);
            
            await axios.post(webhookUrl, {
                username: 'CUBE Anti-Cheat',
                avatar_url: 'https://i.imgur.com/jhUfbwy.png',
                embeds: [summaryEmbed, ...detailEmbeds]
            });
            
            stats.sent++;
            stats.batched += batch.length;
        }
        
        lastWebhookTime = Date.now();
        
    } catch (error) {
        log.error(`Failed to send webhook batch: ${error.message}`);
        stats.failed++;
    }
}

/**
 * Vérifie si le webhook doit être envoyé selon la sévérité
 */
function shouldSendBySeverity(severity, minSeverity) {
    const severityLevels = {
        'INFO': 0,
        'LOW': 1,
        'MEDIUM': 2,
        'HIGH': 3,
        'CRITICAL': 4
    };
    
    const currentLevel = severityLevels[severity] || 0;
    const minLevel = severityLevels[minSeverity] || 3;
    
    return currentLevel >= minLevel;
}

/**
 * Récupère les statistiques des webhooks
 */
function getWebhookStats() {
    return {
        ...stats,
        queueSize: webhookQueue.length
    };
}

/**
 * Réinitialise les statistiques
 */
function resetWebhookStats() {
    stats.sent = 0;
    stats.failed = 0;
    stats.batched = 0;
    stats.dropped = 0;
}

// Flush automatique toutes les 30 secondes
setInterval(flushWebhookQueue, BATCH_INTERVAL);

module.exports = {
    sendWebhook,
    sendBanWebhook,
    sendBanEvasionWebhook,
    sendSpoofWebhook,
    sendReviewWebhook,
    sendMultiAccountWebhook,
    flushWebhookQueue,
    getWebhookStats,
    resetWebhookStats
};

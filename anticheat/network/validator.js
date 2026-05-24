/**
 * Network validation and IP reputation
 * Détecte VPN, proxy, datacenter, TOR
 */

/**
 * Valide et enrichit les informations réseau
 */
async function validateNetwork(ip) {
    try {
        const results = {
            ip,
            asn: null,
            isp: null,
            country: null,
            isDatacenter: false,
            isVpn: false,
            isProxy: false,
            isTor: false,
            reputation: 50, // Score par défaut
            riskScore: 0,
            indicators: []
        };
        
        // === 1. DÉTECTION IP PRIVÉE ===
        if (isPrivateIP(ip)) {
            results.reputation = 100; // IP locale = fiable
            results.indicators.push('Private IP address');
            return results;
        }
        
        // === 2. DÉTECTION DATACENTER ===
        const datacenterCheck = checkDatacenterIP(ip);
        if (datacenterCheck.detected) {
            results.isDatacenter = true;
            results.riskScore += 30;
            results.reputation -= 20;
            results.indicators.push(...datacenterCheck.indicators);
        }
        
        // === 3. DÉTECTION VPN ===
        const vpnCheck = checkVPN(ip);
        if (vpnCheck.detected) {
            results.isVpn = true;
            results.riskScore += 25;
            results.reputation -= 15;
            results.indicators.push(...vpnCheck.indicators);
        }
        
        // === 4. DÉTECTION PROXY ===
        const proxyCheck = checkProxy(ip);
        if (proxyCheck.detected) {
            results.isProxy = true;
            results.riskScore += 20;
            results.reputation -= 15;
            results.indicators.push(...proxyCheck.indicators);
        }
        
        // === 5. DÉTECTION TOR ===
        const torCheck = checkTOR(ip);
        if (torCheck.detected) {
            results.isTor = true;
            results.riskScore += 40;
            results.reputation -= 30;
            results.indicators.push('TOR exit node detected');
        }
        
        // === 6. EXTRACTION ASN/ISP (basique) ===
        const asnInfo = extractASNInfo(ip);
        if (asnInfo) {
            results.asn = asnInfo.asn;
            results.isp = asnInfo.isp;
            results.country = asnInfo.country;
        }
        
        // Limiter reputation entre 0 et 100
        results.reputation = Math.max(0, Math.min(100, results.reputation));
        results.riskScore = Math.min(100, results.riskScore);
        
        return results;
    } catch (error) {
        throw new Error(`Network validation failed: ${error.message}`);
    }
}

/**
 * Vérifie si l'IP est privée
 */
function isPrivateIP(ip) {
    const parts = ip.split('.').map(Number);
    
    if (parts.length !== 4) return false;
    
    // 10.0.0.0/8
    if (parts[0] === 10) return true;
    
    // 172.16.0.0/12
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    
    // 192.168.0.0/16
    if (parts[0] === 192 && parts[1] === 168) return true;
    
    // 127.0.0.0/8 (localhost)
    if (parts[0] === 127) return true;
    
    return false;
}

/**
 * Détecte les IPs datacenter
 */
function checkDatacenterIP(ip) {
    const results = {
        detected: false,
        indicators: []
    };
    
    // Ranges datacenter connus (exemples)
    const datacenterRanges = [
        // AWS
        { start: '3.0.0.0', end: '3.255.255.255', provider: 'AWS' },
        { start: '13.0.0.0', end: '13.255.255.255', provider: 'AWS' },
        { start: '18.0.0.0', end: '18.255.255.255', provider: 'AWS' },
        { start: '52.0.0.0', end: '52.255.255.255', provider: 'AWS' },
        
        // Google Cloud
        { start: '34.0.0.0', end: '34.255.255.255', provider: 'Google Cloud' },
        { start: '35.0.0.0', end: '35.255.255.255', provider: 'Google Cloud' },
        
        // Azure
        { start: '13.64.0.0', end: '13.107.255.255', provider: 'Azure' },
        { start: '20.0.0.0', end: '20.255.255.255', provider: 'Azure' },
        
        // DigitalOcean
        { start: '104.131.0.0', end: '104.131.255.255', provider: 'DigitalOcean' },
        { start: '159.65.0.0', end: '159.65.255.255', provider: 'DigitalOcean' },
        
        // OVH
        { start: '51.38.0.0', end: '51.38.255.255', provider: 'OVH' },
        { start: '51.68.0.0', end: '51.68.255.255', provider: 'OVH' }
    ];
    
    const ipNum = ipToNumber(ip);
    
    for (const range of datacenterRanges) {
        const startNum = ipToNumber(range.start);
        const endNum = ipToNumber(range.end);
        
        if (ipNum >= startNum && ipNum <= endNum) {
            results.detected = true;
            results.indicators.push(`Datacenter IP detected: ${range.provider}`);
            break;
        }
    }
    
    return results;
}

/**
 * Détecte les VPN (basique, sans API externe)
 */
function checkVPN(ip) {
    const results = {
        detected: false,
        indicators: []
    };
    
    // Providers VPN connus (ranges simplifiés)
    const vpnProviders = [
        // NordVPN
        { start: '185.93.0.0', end: '185.93.3.255', provider: 'NordVPN' },
        
        // ExpressVPN
        { start: '103.231.88.0', end: '103.231.91.255', provider: 'ExpressVPN' },
        
        // ProtonVPN
        { start: '185.159.156.0', end: '185.159.159.255', provider: 'ProtonVPN' },
        
        // Surfshark
        { start: '45.89.228.0', end: '45.89.231.255', provider: 'Surfshark' }
    ];
    
    const ipNum = ipToNumber(ip);
    
    for (const range of vpnProviders) {
        const startNum = ipToNumber(range.start);
        const endNum = ipToNumber(range.end);
        
        if (ipNum >= startNum && ipNum <= endNum) {
            results.detected = true;
            results.indicators.push(`VPN detected: ${range.provider}`);
            break;
        }
    }
    
    return results;
}

/**
 * Détecte les proxies
 */
function checkProxy(ip) {
    const results = {
        detected: false,
        indicators: []
    };
    
    // Ranges proxy publics connus (exemples)
    const proxyRanges = [
        { start: '8.8.8.0', end: '8.8.8.255', provider: 'Public Proxy' }
    ];
    
    const ipNum = ipToNumber(ip);
    
    for (const range of proxyRanges) {
        const startNum = ipToNumber(range.start);
        const endNum = ipToNumber(range.end);
        
        if (ipNum >= startNum && ipNum <= endNum) {
            results.detected = true;
            results.indicators.push(`Proxy detected: ${range.provider}`);
            break;
        }
    }
    
    return results;
}

/**
 * Détecte les exit nodes TOR
 */
function checkTOR(ip) {
    const results = {
        detected: false
    };
    
    // Liste simplifiée d'exit nodes TOR (devrait être mise à jour régulièrement)
    // En production, utiliser une API ou une liste à jour
    const torExitNodes = [
        '185.220.101.1',
        '185.220.101.2',
        '185.220.101.3'
        // ... plus d'exit nodes
    ];
    
    if (torExitNodes.includes(ip)) {
        results.detected = true;
    }
    
    return results;
}

/**
 * Extrait les informations ASN/ISP (basique)
 */
function extractASNInfo(ip) {
    // En production, utiliser une API comme ipinfo.io, ipapi.co, etc.
    // Pour l'instant, retourner null (pas d'API externe)
    
    // Exemple de structure de retour:
    // return {
    //     asn: 15169,
    //     isp: 'Google LLC',
    //     country: 'US'
    // };
    
    return null;
}

/**
 * Convertit une IP en nombre pour comparaison
 */
function ipToNumber(ip) {
    const parts = ip.split('.').map(Number);
    return (parts[0] << 24) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

/**
 * Calcule le score de risque réseau
 */
function calculateNetworkRisk(networkInfo) {
    let riskScore = 0;
    
    if (networkInfo.isTor) {
        riskScore += 40;
    }
    
    if (networkInfo.isDatacenter) {
        riskScore += 30;
    }
    
    if (networkInfo.isVpn) {
        riskScore += 25;
    }
    
    if (networkInfo.isProxy) {
        riskScore += 20;
    }
    
    if (networkInfo.reputation < 30) {
        riskScore += 15;
    }
    
    return Math.min(100, riskScore);
}

/**
 * Détermine si le réseau est suspect
 */
function isNetworkSuspicious(networkInfo) {
    // TOR seul = très suspect
    if (networkInfo.isTor) {
        return { suspicious: true, reason: 'TOR network', severity: 'HIGH' };
    }
    
    // Datacenter + VPN = suspect
    if (networkInfo.isDatacenter && networkInfo.isVpn) {
        return { suspicious: true, reason: 'Datacenter + VPN', severity: 'MEDIUM' };
    }
    
    // VPN seul = légèrement suspect (pas suffisant pour ban)
    if (networkInfo.isVpn) {
        return { suspicious: true, reason: 'VPN detected', severity: 'LOW' };
    }
    
    // Reputation très basse
    if (networkInfo.reputation < 20) {
        return { suspicious: true, reason: 'Low IP reputation', severity: 'MEDIUM' };
    }
    
    return { suspicious: false, reason: null, severity: 'NONE' };
}

module.exports = {
    validateNetwork,
    isPrivateIP,
    checkDatacenterIP,
    checkVPN,
    checkProxy,
    checkTOR,
    calculateNetworkRisk,
    isNetworkSuspicious
};

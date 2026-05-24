/**
 * Advanced spoofing detection
 * Détecte les incohérences hardware et les patterns de spoofers
 */

const weights = require('../scoring/weights');

/**
 * Détecte les spoofs avancés (incohérences entre sources)
 */
function detectAdvancedSpoof(fingerprint) {
    const results = {
        detected: false,
        confidence: 0,
        indicators: [],
        flags: []
    };
    
    const hwid = fingerprint.hwid;
    const sources = hwid.sources || {};
    
    // === 1. VÉRIFICATION DES SOURCES ===
    const sourceIndicators = checkSourceConsistency(sources);
    if (sourceIndicators.detected) {
        results.detected = true;
        results.confidence += sourceIndicators.confidence;
        results.indicators.push(...sourceIndicators.indicators);
        results.flags.push(...sourceIndicators.flags);
    }
    
    // === 2. DÉTECTION VM / HYPERVISOR ===
    const vmIndicators = detectVirtualMachine(hwid);
    if (vmIndicators.detected) {
        results.detected = true;
        results.confidence += vmIndicators.confidence;
        results.indicators.push(...vmIndicators.indicators);
        results.flags.push('VM_DETECTED');
    }
    
    // === 3. INCOHÉRENCES HARDWARE ===
    const hardwareIndicators = detectHardwareInconsistencies(hwid);
    if (hardwareIndicators.detected) {
        results.detected = true;
        results.confidence += hardwareIndicators.confidence;
        results.indicators.push(...hardwareIndicators.indicators);
        results.flags.push('HARDWARE_INCONSISTENCY');
    }
    
    // === 4. PATTERNS SPOOFERS CONNUS ===
    const patternIndicators = detectKnownSpooferPatterns(hwid);
    if (patternIndicators.detected) {
        results.detected = true;
        results.confidence += patternIndicators.confidence;
        results.indicators.push(...patternIndicators.indicators);
        results.flags.push('KNOWN_SPOOFER_PATTERN');
    }
    
    // === 5. VALEURS IMPOSSIBLES ===
    const impossibleIndicators = detectImpossibleValues(hwid);
    if (impossibleIndicators.detected) {
        results.detected = true;
        results.confidence += impossibleIndicators.confidence;
        results.indicators.push(...impossibleIndicators.indicators);
        results.flags.push('IMPOSSIBLE_VALUES');
    }
    
    // Limiter confidence à 100
    results.confidence = Math.min(100, results.confidence);
    
    return results;
}

/**
 * Vérifie la cohérence entre les sources de collecte
 */
function checkSourceConsistency(sources) {
    const results = {
        detected: false,
        confidence: 0,
        indicators: [],
        flags: []
    };
    
    const sourceCount = Object.values(sources).filter(Boolean).length;
    
    // Aucune source = très suspect
    if (sourceCount === 0) {
        results.detected = true;
        results.confidence = 60;
        results.indicators.push('No collection sources reported');
        results.flags.push('NO_SOURCES');
        return results;
    }
    
    // WMI seul = facile à spoof
    if (sourceCount === 1 && sources.wmi) {
        results.detected = true;
        results.confidence = 40;
        results.indicators.push('Only WMI source (easily spoofable)');
        results.flags.push('WMI_ONLY');
        return results;
    }
    
    // Registry seul = suspect
    if (sourceCount === 1 && sources.registry) {
        results.detected = true;
        results.confidence = 35;
        results.indicators.push('Only Registry source (easily spoofable)');
        results.flags.push('REGISTRY_ONLY');
        return results;
    }
    
    // Bonus si multiple sources fiables
    if (sources.deviceIoControl && sources.smbiosDirect && sourceCount >= 3) {
        // Machine fiable, pas de détection
        return results;
    }
    
    return results;
}

/**
 * Détecte les machines virtuelles
 */
function detectVirtualMachine(hwid) {
    const results = {
        detected: false,
        confidence: 0,
        indicators: []
    };
    
    // Patterns VM connus
    const vmPatterns = {
        biosVendor: [
            /vmware/i,
            /virtualbox/i,
            /qemu/i,
            /bochs/i,
            /xen/i,
            /kvm/i,
            /hyper-v/i,
            /parallels/i
        ],
        diskModel: [
            /vbox/i,
            /vmware/i,
            /virtual/i,
            /qemu/i
        ],
        baseboardSerial: [
            /none/i,
            /^0+$/,
            /virtualbox/i
        ]
    };
    
    // Vérifier BIOS vendor
    if (hwid.biosVendor) {
        for (const pattern of vmPatterns.biosVendor) {
            if (pattern.test(hwid.biosVendor)) {
                results.detected = true;
                results.confidence = 50;
                results.indicators.push(`VM BIOS detected: ${hwid.biosVendor}`);
                break;
            }
        }
    }
    
    // Vérifier disk model
    if (hwid.diskModel) {
        for (const pattern of vmPatterns.diskModel) {
            if (pattern.test(hwid.diskModel)) {
                results.detected = true;
                results.confidence = Math.max(results.confidence, 45);
                results.indicators.push(`VM disk detected: ${hwid.diskModel}`);
                break;
            }
        }
    }
    
    // Vérifier baseboard serial
    if (hwid.baseboardSerial) {
        for (const pattern of vmPatterns.baseboardSerial) {
            if (pattern.test(hwid.baseboardSerial)) {
                results.detected = true;
                results.confidence = Math.max(results.confidence, 40);
                results.indicators.push(`VM baseboard detected: ${hwid.baseboardSerial}`);
                break;
            }
        }
    }
    
    // Absence de TPM = indicateur VM (mais pas seul)
    if (!hwid.tpmPresent && results.detected) {
        results.confidence += 10;
        results.indicators.push('No TPM present (common in VMs)');
    }
    
    return results;
}

/**
 * Détecte les incohérences hardware
 */
function detectHardwareInconsistencies(hwid) {
    const results = {
        detected: false,
        confidence: 0,
        indicators: []
    };
    
    // === CPU vs GPU incohérence ===
    // CPU moderne avec GPU très ancien = suspect
    if (hwid.cpuModel && hwid.gpuDevice) {
        const cpuGeneration = extractCpuGeneration(hwid.cpuModel);
        const gpuGeneration = extractGpuGeneration(hwid.gpuDevice);
        
        if (cpuGeneration && gpuGeneration) {
            const generationGap = cpuGeneration - gpuGeneration;
            if (generationGap > 5) {
                results.detected = true;
                results.confidence = 25;
                results.indicators.push(`Large CPU/GPU generation gap: ${generationGap} generations`);
            }
        }
    }
    
    // === RAM incohérence ===
    // RAM amount impossible (ex: 3GB, 5GB, 7GB)
    if (hwid.ramAmount) {
        const ramGB = hwid.ramAmount / (1024 * 1024 * 1024);
        const commonSizes = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 128];
        const isCommonSize = commonSizes.some(size => Math.abs(ramGB - size) < 0.5);
        
        if (!isCommonSize && ramGB > 1) {
            results.detected = true;
            results.confidence = 20;
            results.indicators.push(`Unusual RAM amount: ${ramGB.toFixed(2)}GB`);
        }
    }
    
    // === BIOS date incohérence ===
    // BIOS date dans le futur ou trop ancien pour le hardware
    if (hwid.biosDate) {
        const biosDate = new Date(hwid.biosDate);
        const now = new Date();
        
        if (biosDate > now) {
            results.detected = true;
            results.confidence = 40;
            results.indicators.push('BIOS date in the future');
        }
        
        // BIOS trop ancien pour CPU moderne
        const biosYear = biosDate.getFullYear();
        if (hwid.cpuModel && biosYear < 2010) {
            const cpuGen = extractCpuGeneration(hwid.cpuModel);
            if (cpuGen && cpuGen > 6) {
                results.detected = true;
                results.confidence = 30;
                results.indicators.push(`BIOS too old (${biosYear}) for modern CPU`);
            }
        }
    }
    
    // === Secure Boot sans TPM ===
    if (hwid.secureBootEnabled && !hwid.tpmPresent) {
        results.detected = true;
        results.confidence = 25;
        results.indicators.push('Secure Boot enabled without TPM (unusual)');
    }
    
    return results;
}

/**
 * Détecte les patterns de spoofers connus
 */
function detectKnownSpooferPatterns(hwid) {
    const results = {
        detected: false,
        confidence: 0,
        indicators: []
    };
    
    // Patterns génériques OEM
    const genericPatterns = [
        /^To be filled by O\.E\.M\.$/i,
        /^Default string$/i,
        /^Not Specified$/i,
        /^System manufacturer$/i,
        /^System Product Name$/i,
        /^Type1ProductConfigId$/i,
        /^SKU$/i,
        /^None$/i,
        /^N\/A$/i,
        /^Unknown$/i
    ];
    
    const fieldsToCheck = [
        { field: 'biosVendor', weight: 15 },
        { field: 'baseboardSerial', weight: 30 },
        { field: 'diskModel', weight: 10 }
    ];
    
    for (const { field, weight } of fieldsToCheck) {
        const value = hwid[field];
        if (!value) continue;
        
        for (const pattern of genericPatterns) {
            if (pattern.test(value)) {
                results.detected = true;
                results.confidence += weight;
                results.indicators.push(`Generic OEM value in ${field}: "${value}"`);
                break;
            }
        }
    }
    
    // Pattern UUID null
    if (hwid.smbiosUuid) {
        const nullUuidPatterns = [
            /^0{8}-0{4}-0{4}-0{4}-0{12}$/i,
            /^F{8}-F{4}-F{4}-F{4}-F{12}$/i,
            /^0{32}$/i,
            /^F{32}$/i
        ];
        
        for (const pattern of nullUuidPatterns) {
            if (pattern.test(hwid.smbiosUuid.replace(/-/g, ''))) {
                results.detected = true;
                results.confidence += 50;
                results.indicators.push(`Null/invalid SMBIOS UUID: ${hwid.smbiosUuid}`);
                break;
            }
        }
    }
    
    // Pattern serial null
    const serialFields = ['diskSerial', 'baseboardSerial'];
    for (const field of serialFields) {
        const value = hwid[field];
        if (!value) continue;
        
        if (/^(0{8,}|1{8,}|X{8,}|Z{8,})$/i.test(value)) {
            results.detected = true;
            results.confidence += 35;
            results.indicators.push(`Null/invalid ${field}: ${value}`);
        }
    }
    
    return results;
}

/**
 * Détecte les valeurs impossibles
 */
function detectImpossibleValues(hwid) {
    const results = {
        detected: false,
        confidence: 0,
        indicators: []
    };
    
    // UUID trop court ou trop long
    if (hwid.smbiosUuid) {
        const uuidClean = hwid.smbiosUuid.replace(/-/g, '');
        if (uuidClean.length !== 32) {
            results.detected = true;
            results.confidence = 40;
            results.indicators.push(`Invalid SMBIOS UUID length: ${uuidClean.length}`);
        }
    }
    
    // RAM amount négatif ou zéro
    if (hwid.ramAmount !== null && hwid.ramAmount <= 0) {
        results.detected = true;
        results.confidence = 50;
        results.indicators.push(`Invalid RAM amount: ${hwid.ramAmount}`);
    }
    
    // RAM slots impossible
    if (hwid.ramSlots !== null && (hwid.ramSlots <= 0 || hwid.ramSlots > 16)) {
        results.detected = true;
        results.confidence = 30;
        results.indicators.push(`Impossible RAM slots: ${hwid.ramSlots}`);
    }
    
    // BIOS date invalide
    if (hwid.biosDate) {
        const biosDate = new Date(hwid.biosDate);
        if (isNaN(biosDate.getTime()) || biosDate.getFullYear() < 1990) {
            results.detected = true;
            results.confidence = 35;
            results.indicators.push(`Invalid BIOS date: ${hwid.biosDate}`);
        }
    }
    
    return results;
}

/**
 * Extrait la génération du CPU (Intel/AMD)
 */
function extractCpuGeneration(cpuModel) {
    if (!cpuModel) return null;
    
    // Intel: i7-10700K = 10th gen
    const intelMatch = cpuModel.match(/i[3579]-(\d{1,2})\d{3}/i);
    if (intelMatch) {
        return parseInt(intelMatch[1]);
    }
    
    // AMD Ryzen: Ryzen 7 5800X = 5th gen
    const amdMatch = cpuModel.match(/Ryzen\s+[3579]\s+(\d{1})\d{3}/i);
    if (amdMatch) {
        return parseInt(amdMatch[1]);
    }
    
    return null;
}

/**
 * Extrait la génération du GPU (NVIDIA/AMD)
 */
function extractGpuGeneration(gpuDevice) {
    if (!gpuDevice) return null;
    
    // NVIDIA: GTX 1080 = 10xx series, RTX 3080 = 30xx series
    const nvidiaMatch = gpuDevice.match(/(GTX|RTX)\s+(\d{1,2})\d{2}/i);
    if (nvidiaMatch) {
        return parseInt(nvidiaMatch[2]);
    }
    
    // AMD: RX 6800 = 6xxx series
    const amdMatch = gpuDevice.match(/RX\s+(\d{1})\d{3}/i);
    if (amdMatch) {
        return parseInt(amdMatch[1]);
    }
    
    return null;
}

module.exports = {
    detectAdvancedSpoof,
    checkSourceConsistency,
    detectVirtualMachine,
    detectHardwareInconsistencies,
    detectKnownSpooferPatterns,
    detectImpossibleValues
};
